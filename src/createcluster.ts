'use strict';

import { TextDocumentContentProvider, Uri, EventEmitter, Event, ProviderResult, CancellationToken } from 'vscode';
import { Shell } from './shell';
import { FS } from './fs';
import { Advanceable, Errorable, UIRequest, StageData, OperationState, OperationMap, advanceUri as wizardAdvanceUri, selectionChangedScript as wizardSelectionChangedScript, selectionChangedScriptMulti as wizardSelectionChangedScriptMulti, script, waitScript, extend, ControlMapping } from './wizard';
import { error } from 'util';

export const uriScheme : string = "k8screatecluster";

export function operationUri(operationId: string) : Uri {
    return Uri.parse(`${uriScheme}://operations/${operationId}`);
}

export function uiProvider(fs: FS, shell: Shell) : TextDocumentContentProvider & Advanceable {
    return new UIProvider(fs, shell);
}

// Sequence:
// * Which cloud?
//   * Which subscription?
//   * Cluster name, RG name (and check if RG exists cos we need to create it if not), location
//   * Master VM size, master count (ACS only - skip maybe?)
//   * Agent VM size, agent count, agent OS disk size (?)
//   * k8s version? (AKS = -k, ACS = --orchestrator-type + --orchestrator-release)
//   * az acs/aks create --no-wait

enum OperationStage {
    Initial,
    PromptForClusterType,
    AzurePromptForSubscription,
    AzurePromptForMetadata,
    AzurePromptForAgentSettings,
    InternalError,
    Complete,
}

interface Context {
    readonly fs: FS;
    readonly shell: Shell;
}

// TODO: feels like we should be able to deduplicate this with the ACS UI provider
class UIProvider implements TextDocumentContentProvider, Advanceable {
    
    private readonly context;

    constructor(fs: FS, shell: Shell) {
        this.context = { fs: fs, shell: shell };
    }

    private _onDidChange: EventEmitter<Uri> = new EventEmitter<Uri>();
    readonly onDidChange: Event<Uri> = this._onDidChange.event;

    private operations: OperationMap<OperationStage> = new OperationMap<OperationStage>();

    provideTextDocumentContent(uri: Uri, token: CancellationToken) : ProviderResult<string> {
        const operationId = uri.path.substr(1);
        const operationState = this.operations.get(operationId);
        return render(operationId, operationState);
    }

    start(operationId: string): void {
        const initialStage = {
            stage: OperationStage.Initial,
            last: {
                actionDescription: '',
                result: { succeeded: true, result: null, error: [] }
            }
        };
        this.operations.set(operationId, initialStage);
        this._onDidChange.fire(operationUri(operationId));
    }

    async next(request: UIRequest): Promise<void> {
        const operationId = request.operationId;
        const sourceState = this.operations.get(operationId);
        const result = await next(this.context, sourceState, request.requestData);
        this.operations.set(operationId, result);
        this._onDidChange.fire(operationUri(operationId));
    }
}
    
async function next(context: Context, sourceState: OperationState<OperationStage>, requestData: string) : Promise<OperationState<OperationStage>> {
    switch (sourceState.stage) {
        case OperationStage.Initial:
            return {
                last: listClusterTypes(),
                stage: OperationStage.PromptForClusterType,
            };
        case OperationStage.PromptForClusterType:
            const selectedClusterType : string = requestData;
            if (selectedClusterType == 'Azure Kubernetes Service' || selectedClusterType == 'Azure Container Service') {
                const subscriptions = await getSubscriptionList(context);
                const pctStateInfo = extend(subscriptions.result, (subs) => { return { clusterType: selectedClusterType, subscriptions: subs }; });
                return {
                    last: { actionDescription: 'selecting cluster type', result: pctStateInfo },
                    stage: OperationStage.AzurePromptForSubscription
                };
            } else {
                return {
                    last: unsupportedClusterType(selectedClusterType),
                    stage: OperationStage.InternalError
                };
            }
        case OperationStage.AzurePromptForSubscription:
            const selectedSubscription : string = requestData;
            const selectedClusterTypeEx = sourceState.last.result.result.clusterType;  // TODO: why the insane nesting?  // TODO: rename
            const psStateInfo = {clusterType: selectedClusterTypeEx, subscription: selectedSubscription };
            return {
                last: { actionDescription: 'selecting subscription', result: { succeeded: true, result: psStateInfo, error: [] } },
                stage: OperationStage.AzurePromptForMetadata
            };
        case OperationStage.AzurePromptForMetadata:
            const metadata = JSON.parse(requestData);
            const pmStateInfo = extend(sourceState.last.result, (v) => Object.assign({}, v, {metadata: metadata}));
            return {
                last: { actionDescription: 'collecting cluster metadata', result: pmStateInfo },
                stage: OperationStage.AzurePromptForAgentSettings
            };
        case OperationStage.AzurePromptForAgentSettings:
            const agentSettings = JSON.parse(requestData);
            const pasStateInfo = extend(sourceState.last.result, (v) => Object.assign({}, v, {agentSettings: agentSettings}));
            const creationResult = await createCluster(context, pasStateInfo.result);
            return {
                last: creationResult,
                stage: OperationStage.Complete
            };
        default:
            return {
                stage: sourceState.stage,
                last: sourceState.last
            };
    }
}

function unsupportedClusterType(clusterType: string) : StageData {
    return {
        actionDescription: 'selecting cluster type',
        result: { succeeded: false, result: '', error: ['Unsupported cluster type ' + clusterType] }
    };
}

function listClusterTypes() : StageData {
    const clusterTypes = [
        'Azure Kubernetes Service',
        'Azure Container Service'
    ];
    return {
        actionDescription: 'listing cluster types',
        result: { succeeded: true, result: clusterTypes, error: [] }
    };
}

// TODO: this is an exact duplicate of code in acs.ts

async function getSubscriptionList(context: Context) : Promise<StageData> {
    // check for prerequisites
    const prerequisiteErrors = await verifyPrerequisitesAsync(context);
    if (prerequisiteErrors.length > 0) {
        return {
            actionDescription: 'checking prerequisites',
            result: { succeeded: false, result: false, error: prerequisiteErrors }
        };
    }

    // list subs
    const subscriptions = await listSubscriptionsAsync(context);
    return {
        actionDescription: 'listing subscriptions',
        result: subscriptions
    };
}

async function verifyPrerequisitesAsync(context: Context) : Promise<string[]> {
    const errors = new Array<string>();
    
    const sr = await context.shell.exec('az --help');
    if (sr.code !== 0 || sr.stderr) {
        errors.push('Azure CLI 2.0 not found - install Azure CLI 2.0 and log in');
    }

    prereqCheckSSHKeys(context, errors);

    return errors;
}

function prereqCheckSSHKeys(context: Context, errors: Array<String>) {
    const sshKeyFile = context.shell.combinePath(context.shell.home(), '.ssh/id_rsa');
    if (!context.fs.existsSync(sshKeyFile)) {
        errors.push('SSH keys not found - expected key file at ' + sshKeyFile);
    }
}

async function listSubscriptionsAsync(context: Context) : Promise<Errorable<string[]>> {
    const sr = await context.shell.exec("az account list --all --query [*].name -ojson");
    
    if (sr.code === 0 && !sr.stderr) {  // az account list returns exit code 0 even if not logged in
        const accountNames : string[] = JSON.parse(sr.stdout);
        return { succeeded: true, result: accountNames, error: [] };
    } else {
        return { succeeded: false, result: [], error: [sr.stderr] };
    }
}

async function loginAsync(context: Context, subscription: string) : Promise<Errorable<void>> {
    const sr = await context.shell.exec(`az account set --subscription "${subscription}"`);

    if (sr.code === 0 && !sr.stderr) {
        return { succeeded: true, result: null, error: [] };
    } else {
        return { succeeded: false, result: null, error: [sr.stderr] };
    }
}

// end TODO

async function resourceGroupExists(context: Context, resourceGroupName: string) : Promise<boolean> {
    const sr = await context.shell.exec(`az group show -n "${resourceGroupName}" -ojson`);
    
    if (sr.code === 0 && !sr.stderr) {
        return sr.stdout !== null && sr.stdout.length > 0;
    } else {
        return false;
    }
 
}

async function ensureResourceGroupAsync(context: Context, resourceGroupName: string, location: string) : Promise<Errorable<void>> {
    if (await resourceGroupExists(context, resourceGroupName)) {
        return { succeeded: true, result: null, error: [] };
    }

    const sr = await context.shell.exec(`az group create -n "${resourceGroupName}" -l "${location}"`);

    if (sr.code === 0 && !sr.stderr) {
        return { succeeded: true, result: null, error: [] };
    } else {
        return { succeeded: false, result: null, error: [sr.stderr] };
    }
}

async function execCreateClusterCmd(context: Context, options: any) : Promise<Errorable<void>> {
    let clusterCmd = 'aks';
    if (options.clusterType == 'Azure Container Service') {
        clusterCmd = 'acs';
    }
    let createCmd = `az ${clusterCmd} create -n "${options.metadata.clusterName}" -g "${options.metadata.resourceGroupName}" -l "${options.metadata.location}" --agent-count ${options.agentSettings.count} --agent-vm-size "${options.agentSettings.vmSize}" --no-wait`;  // use long form options for ACS compatibility
    if (clusterCmd == 'acs') {
        createCmd = createCmd + " -t Kubernetes";
    }
    
    const sr = await context.shell.exec(createCmd);

    if (sr.code === 0 && !sr.stderr) {
        return { succeeded: true, result: null, error: [] };
    } else {
        return { succeeded: false, result: null, error: [sr.stderr] };
    }
}

async function createCluster(context: Context, options: any) : Promise<StageData> {
    const description = `
    Created ${options.clusterType} cluster ${options.metadata.clusterName} in ${options.metadata.resourceGroupName} with ${options.agentSettings.count} agents.
    `;

    const login = await loginAsync(context, options.subscription);
    if (!login.succeeded) {
        return {
            actionDescription: 'logging into subscription',
            result: login
        };
    }

    const ensureResourceGroup = await ensureResourceGroupAsync(context, options.metadata.resourceGroupName, options.metadata.location);
    if (!ensureResourceGroup.succeeded) {
        return {
            actionDescription: 'ensuring resource group exists',
            result: ensureResourceGroup
        };
    }

    const createCluster = await execCreateClusterCmd(context, options);

    return {
        actionDescription: 'creating cluster',
        result: createCluster
    };
}

function render(operationId: string, state: OperationState<OperationStage>) : string {
    switch (state.stage) {
        case OperationStage.Initial:
             return renderInitial();
        case OperationStage.PromptForClusterType:
            return renderPromptForClusterType(operationId, state.last);
        case OperationStage.AzurePromptForSubscription:
            return renderPromptForSubscription(operationId, state.last);
        case OperationStage.AzurePromptForMetadata:
            return renderPromptForMetadata(operationId, state.last);
        case OperationStage.AzurePromptForAgentSettings:
            return renderPromptForAgentSettings(operationId, state.last);
        case OperationStage.InternalError:
           return renderInternalError(state.last);
        case OperationStage.Complete:
            return renderComplete(state.last);
        default:
            return internalError(`Unknown operation stage ${state.stage}`);
    }
}

function renderInitial() : string {
    return '<!-- Initial --><h1>Listing cluster types</h1><p>Please wait...</p>';
}

function renderPromptForClusterType(operationId: string, last: StageData) : string {
    const clusterTypes : string[] = last.result.result;
    const initialUri = advanceUri(operationId, clusterTypes[0]);
    const options = clusterTypes.map((s) => `<option value="${s}">${s}</option>`).join('\n');
    return `<!-- PromptForClusterType -->
            <h1 id='h'>Choose cluster type</h1>
            ${styles()}
            ${waitScript('Contacting cloud')}
            ${selectionChangedScript(operationId)}
            <div id='content'>
            <p>
            Cluster type: <select id='selector' onchange='selectionChanged()'>
            ${options}
            </select>
            </p>

            <p>
            <a id='nextlink' href='${initialUri}' onclick='promptWait()'>Next &gt;</a>
            </p>
            </div>`;
}

// TODO: duplicate of code in acs.ts
function renderPromptForSubscription(operationId: string, last: StageData) : string {
    if (!last.result.succeeded) {
        return notifyCliError('PromptForSubscription', last);
    }
    const subscriptions : string[] = last.result.result.subscriptions;
    if (!subscriptions || subscriptions.length === 0) {
        return notifyNoOptions('PromptForSubscription', 'No subscriptions', 'There are no Azure subscriptions associated with your Azure login.');
    }
    const initialUri = advanceUri(operationId, subscriptions[0]);
    const options = subscriptions.map((s) => `<option value="${s}">${s}</option>`).join('\n');
    return `<!-- PromptForSubscription -->
            <h1 id='h'>Choose subscription</h1>
            ${styles()}
            ${selectionChangedScript(operationId)}
            <div id='content'>
            <p>
            Azure subscription: <select id='selector' onchange='selectionChanged()'>
            ${options}
            </select>
            </p>

            <p><b>Important! The selected subscription will be set as the active subscription for the Azure CLI.</b></p>

            <p>
            <a id='nextlink' href='${initialUri}' onclick='promptWait()'>Next &gt;</a>
            </p>
            </div>`;
}

function renderPromptForMetadata(operationId: string, last: StageData) : string {
    // TODO: make this part of data model, and derive from cluster type (for AKS preview regions)
    const locations : string[] = [ 'Australia Southeast', 'East US', 'Central US', 'West US', 'Europe West' ];
    const initialUri = advanceUri(operationId, `{"location":"${locations[0]}","clusterName":"k8scluster","resourceGroupName":"k8scluster"}`);
    const options = locations.map((s) => `<option value="${s}">${s}</option>`).join('\n');
    const mappings = [
        {ctrlName: "selector", extractVal: "locationCtrl.options[locationCtrl.selectedIndex].value", jsonKey: "location"},
        {ctrlName: "clustername", extractVal: "clusterNameCtrl.value", jsonKey: "clusterName"},
        {ctrlName: "resourcegroupname", extractVal: "resourceGroupNameCtrl.value", jsonKey: "resourceGroupName"}
    ];
    return `<!-- PromptForMetadata -->
            <h1 id='h'>Azure cluster settings</h1>
            ${styles()}
            ${selectionChangedScriptMulti(operationId, mappings)}
            <div id='content'>
            <p>Cluster name: <input id='clustername' type='text' value='k8scluster' onchange='selectionChanged()'/>
            <p>Resource group name: <input id='resourcegroupname' type='text' value='k8scluster' onchange='selectionChanged()'/>
            <p>
            Location: <select id='selector' onchange='selectionChanged()'>
            ${options}
            </select>
            </p>

            <p>
            <a id='nextlink' href='${initialUri}' onclick='promptWait()'>Next &gt;</a>
            </p>
            </div>`;
}

function renderPromptForAgentSettings(operationId: string, last: StageData) : string {
    const vmSizes : string[] = [ 'Standard_D2_v2', 'Standard_D3_v2', 'Standard_D4_v2' ];
    const initialUri = advanceUri(operationId, `{"vmSize": "${vmSizes[0]}", "count": 3}`);
    const options = vmSizes.map((s) => `<option value="${s}">${s}</option>`).join('\n');
    const mappings = [
        {ctrlName: "selector", extractVal: "vmSizeCtrl.options[vmSizeCtrl.selectedIndex].value", jsonKey: "vmSize"},
        {ctrlName: "agentcount", extractVal: "countCtrl.value", jsonKey: "count"},
    ];
    return `<!-- PromptForAgentSettings -->
            <h1 id='h'>Azure agent settings</h1>
            ${styles()}
            ${waitScript('Creating cluster')}
            ${selectionChangedScriptMulti(operationId, mappings)}
            <div id='content'>
            <p>Agent count: <input id='agentcount' type='text' value='3' onchange='selectionChanged()'/>
            <p>
            Agent VM size: <select id='selector' onchange='selectionChanged()'>
            ${options}
            </select>
            </p>

            <p>
            <a id='nextlink' href='${initialUri}' onclick='promptWait()'>Create &gt;</a>
            </p>
            </div>`;

}

function renderComplete(last: StageData) : string {
    const title = last.result.succeeded ? 'Cluster creation has started' : `Error ${last.actionDescription}`;
    const message = last.result.succeeded ?
        `<p class='success'>Azure is creating the cluster, but this may take some time. You can now close this window.</p>` :
        `<p class='error'>An error occurred while creating the cluster.</p>
         <p><b>Details</b></p>
         <p>${last.result.error[0]}</p>`;
    return `<!-- Complete -->
            <h1>${title}</h1>
            ${styles()}
            ${message}`;
}

function renderInternalError(last: StageData) : string {
    return internalError(last.result.error[0]);
}

// TODO: consider consolidating notifyCliError, notifyNoOptions, internalError() and styles() with acs
// (note text of notifyCliError is slightly different though)
function notifyCliError(stageId: string, last: StageData) : string {
    return `<!-- ${stageId} -->
        <h1>Error ${last.actionDescription}</h1>
        <p><span class='error'>The Azure command line failed.</span>  See below for the error message.  You may need to:</p>
        <ul>
        <li>Log into the Azure CLI (run az login in the terminal)</li>
        <li>Install the Azure CLI <a href='https://docs.microsoft.com/cli/azure/install-azure-cli'>(see the instructions for your operating system)</a></li>
        </ul>
        <p><b>Details</b></p>
        <p>${last.result.error}</p>`;
}

function notifyNoOptions(stageId: string, title: string, message: string) : string {
    return `
<h1>${title}</h1>
${styles()}
<p class='error'>${message}</p>
`;
}
function internalError(error: string) : string {
    return `
<h1>Internal extension error</h1>
${styles()}
<p class='error'>An internal error occurred in the vscode-kubernetes-tools extension.</p>
<p>This is not an Azure or Kubernetes issue.  Please report error text '${error}' to the extension authors.</p>
`;
}

function styles() : string {
    return `
<style>
.vscode-light a {
    color: navy;
}

.vscode-dark a {
    color: azure;
}

.vscode-light .error {
    color: red;
    font-weight: bold;
}

.vscode-dark .error {
    color: red;
    font-weight: bold;
}

.vscode-light .success {
    color: green;
    font-weight: bold;
}

.vscode-dark .success {
    color: darkseagreen;
    font-weight: bold;
}
</style>
`;
}

const commandName = 'vsKubernetesCreateCluster';

function advanceUri(operationId: string, requestData: string) : string {
    return wizardAdvanceUri(commandName, operationId, requestData);
}

function selectionChangedScript(operationId: string) : string {
    return wizardSelectionChangedScript(commandName, operationId);
}

function selectionChangedScriptMulti(operationId: string, mappings: ControlMapping[]) : string {
    return wizardSelectionChangedScriptMulti(commandName, operationId, mappings);
}


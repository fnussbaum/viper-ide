'use strict';
import { SymbolKind } from 'vscode-languageserver-types/lib/main';
import { settings } from 'cluster';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below

import { IPCMessageReader, IPCMessageWriter, Location, Position, Range, createConnection, InitializeResult, SymbolInformation } from 'vscode-languageserver';
import { Log } from './Log';
import { Settings } from './Settings'
import { Backend, Common, StateColors, ExecutionTrace, ViperSettings, Commands, VerificationState, VerifyRequest, LogLevel, ShowHeapParams } from './ViperProtocol'
import { VerificationTask } from './VerificationTask';
import { Statement } from './Statement';
import { DebugServer } from './DebugServer';
import { Server } from './ServerClass';
import { ViperServerService } from './ViperServerService';
import * as fs from 'fs';
import * as pathHelper from 'path';

// Create a connection for the server. The connection uses Node's IPC as a transport
Server.connection = createConnection(new IPCMessageReader(process), new IPCMessageWriter(process));
Server.documents.listen(Server.connection);

registerHandlers();

// Listen on the connection
Server.connection.listen();

function registerHandlers() {
    //starting point (executed once)
    Server.connection.onInitialize((params): InitializeResult => {
        try {
            Log.log("Debug Server is initializing", LogLevel.LowLevelDebug);
            DebugServer.initialize();
            return {
                capabilities: {
                    documentSymbolProvider: true,
                    definitionProvider: true
                }
            }
        } catch (e) {
            Log.error("Error handling initialize request: " + e);
        }
    });

    Server.connection.onShutdown(() => {
        try {
            Log.log("On Shutdown", LogLevel.Debug);
            Server.backendService.stop();
        } catch (e) {
            Log.error("Error handling shutdown: " + e);
        }
    })

    Server.connection.onDidChangeConfiguration((change) => {
        try {
            Log.log('Configuration changed', LogLevel.Info);
            let oldSettings = Settings.settings;
            Settings.settings = <ViperSettings>change.settings.viperSettings;
            Log.logLevel = Settings.settings.preferences.logLevel; //after this line, Logging works
            Server.refreshEndings();
            Settings.initiateBackendRestartIfNeeded(oldSettings);
        } catch (e) {
            Log.error("Error handling configuration change: " + e);
        }
    });

    Server.connection.onDidChangeTextDocument((change) => {
        let task = Server.verificationTasks.get(change.textDocument.uri.toString());
        if (task) {
            task.symbolInformation = [];
            task.definitions = [];
        }
    });

    Server.connection.onRequest('textDocument/documentSymbol', (args) => {
        return new Promise<SymbolInformation[]>((resolve, reject) => {
            let task = Server.verificationTasks.get(args.textDocument.uri.toString());
            if (task) {
                resolve(task.symbolInformation);
            } else {
                reject();
            }
        })
    });

    Server.connection.onRequest('textDocument/definition', (args) => {
        //Log.log("Handling definitions request", LogLevel.Debug);
        //Log.log("Args: "+ JSON.stringify(args), LogLevel.Debug);
        return new Promise<any>((resolve, reject) => {
            try {
                let document = args.textDocument;
                let pos = args.position;
                let task = Server.verificationTasks.get(document.uri.toString());
                if (task) {
                    //Log.log("Get Identifier", LogLevel.LowLevelDebug)
                    Server.connection.sendRequest(Commands.GetIdentifier, pos).then((indentifier: string) => {
                        //Log.log("Got Identifier", LogLevel.LowLevelDebug)
                        task.definitions.forEach(def => {
                            if (def.scope == null //global scope
                                || (Common.comparePosition(def.scope.start, pos) <= 0 && Common.comparePosition(def.scope.end, pos) >= 0)) // in scope
                            {
                                if (indentifier == def.name) {
                                    resolve({ uri: document.uri.toString(), range: def.location })
                                    return;
                                }
                            }
                        })
                        reject("No definition found");
                    })

                } else {
                    reject("file not found found");
                }
            } catch (e) {
                Log.error("Error handling definitions request: " + e);
                reject();
            }
        })
    });

    Server.connection.onNotification(Commands.StartBackend, (selectedBackend: string) => {
        try {
            if (!selectedBackend || selectedBackend.length == 0) {
                Log.log("No backend was chosen, don't restart backend", LogLevel.Debug);
            } else {
                checkSettingsAndStartServer(selectedBackend);
            }
        } catch (e) {
            Log.error("Error handling select backend request: " + e);
        }
    });

    Server.connection.onNotification(Commands.StopBackend, () => {
        try {
            Server.backendService.stop();
        } catch (e) {
            Log.error("Error handling stop backend request: " + e);
        }
    });

    Server.connection.onNotification(Commands.SwapBackend, (backendName: string) => {
        try {
            Server.backendService.swapBackend(Settings.getBackend(backendName));
        } catch (e) {
            Log.error("Error handling swap backend request: " + e);
        }
    });

    //returns the a list of all backend names
    Server.connection.onRequest(Commands.RequestBackendNames, () => {
        return new Promise<string[]>((resolve, reject) => {
            try {
                let backendNames: string[] = Settings.getBackendNames(Settings.settings);
                if (!backendNames) {
                    reject("No backend found");
                }
                else {
                    resolve(backendNames);
                }
            } catch (e) {
                reject("Error handling backend names request: " + e);
            }
        });
    });

    Server.connection.onDidOpenTextDocument((params) => {
        try {
            Server.isViperSourceFile(params.textDocument.uri).then(res => {
                if (res) {
                    let uri = params.textDocument.uri;
                    //notify client;
                    Server.sendFileOpenedNotification(params.textDocument.uri);
                    if (!Server.verificationTasks.has(uri)) {
                        //create new task for opened file
                        let task = new VerificationTask(uri);
                        Server.verificationTasks.set(uri, task);
                    }
                }
            });
        } catch (e) {
            Log.error("Error handling TextDocument openend");
        }
    });

    Server.connection.onDidCloseTextDocument((params) => {
        try {
            let uri = params.textDocument.uri;
            Server.isViperSourceFile(uri).then(isViperFile => {
                if (isViperFile) {
                    //notify client;
                    Server.sendFileClosedNotification(uri);
                }
            });
        } catch (e) {
            Log.error("Error handling TextDocument closed");
        }
    });

    Server.connection.onNotification(Commands.FileClosed, (uri) => {
        if (Server.verificationTasks.has(uri)) {
            //remove no longer needed task
            let task = Server.verificationTasks.get(uri);
            task.resetDiagnostics();
            Server.verificationTasks.delete(uri);
        }
    });

    Server.connection.onNotification(Commands.Verify, (data: VerifyRequest) => {
        try {
            let verificationstarted = false;
            //it does not make sense to reverify if no changes were made and the verification is already running
            if (canVerificationBeStarted(data.uri, data.manuallyTriggered)) {
                Settings.workspace = data.workspace;
                Log.log("start or restart verification", LogLevel.Info);
                //stop all other verifications because the backend crashes if multiple verifications are run in parallel
                VerificationTask.stopAllRunningVerifications().then(success => {
                    //start verification
                    Server.executedStages = [];
                    verificationstarted = Server.verificationTasks.get(data.uri).verify(data.manuallyTriggered) === true;
                    if (!verificationstarted) {
                        Server.sendVerificationNotStartedNotification(data.uri);
                    }
                }, () => {
                    Server.sendVerificationNotStartedNotification(data.uri);
                });
            } else {
                Log.log("The verification cannot be started.", LogLevel.Info);
                Server.sendVerificationNotStartedNotification(data.uri);
            }
        } catch (e) {
            Log.error("Error handling verify request: " + e);
            Server.sendVerificationNotStartedNotification(data.uri);
        }
    });

    Server.connection.onNotification(Commands.UpdateViperTools, () => {
        Server.updateViperTools(false);
    });

    Server.connection.onNotification(Commands.FlushCache, file => {
        try {
            if (Server.backendService.isViperServerService) {
                (<ViperServerService>Server.backendService).flushCache(file);
            }
        } catch (e) {
            Log.error("Error flushing cache: " + e);
        }
    });

    Server.connection.onRequest(Commands.Dispose, () => {
        return new Promise((resolve, reject) => {
            try {
                //if there are running verifications, stop related processes
                Server.verificationTasks.forEach(task => {
                    if (task.running) {
                        Log.log("stop verification of " + task.filename, LogLevel.Default);
                        if (task.verifierProcess) {
                            Server.backendService.stopVerification(task.verifierProcess.pid);
                        } else {
                            Server.backendService.stopVerification();
                        }
                    }
                });

                console.log("dispose language server");
                Server.backendService.kill();
                resolve();
            } catch (e) {
                Log.error("Error handling dispose request: " + e);
                reject();
            }
        });
    });

    Server.connection.onRequest(Commands.GetExecutionTrace, (params: { uri: string, clientState: number }) => {
        Log.log("Generate execution trace for client state " + params.clientState, LogLevel.Debug);
        return new Promise<ExecutionTrace[]>((resolve, reject) => {
            let result: ExecutionTrace[] = [];
            try {
                let task = Server.verificationTasks.get(params.uri);
                let serverState = task.clientStepIndexToServerStep[params.clientState];
                let maxDepth = serverState.depthLevel();
                let dark = Settings.settings.advancedFeatures.darkGraphs === true;

                if (!Settings.settings.advancedFeatures.simpleMode) {
                    //ADVANCED MODE ONLY
                    //get stateExpansion states
                    serverState.verifiable.forAllExpansionStatesWithDecoration(serverState, (child: Statement) => {
                        result.push({
                            state: child.decorationOptions.index,
                            color: StateColors.uninterestingState(dark),
                            showNumber: true
                        });
                    });
                    //get top level statements
                    serverState.verifiable.getTopLevelStatesWithDecoration().forEach(child => {
                        result.push({
                            state: child.decorationOptions.index,
                            color: StateColors.uninterestingState(dark),
                            showNumber: true
                        });
                    });
                }
                //BOTH SIMPLE AND ANVANCED MODE
                //get executionTrace of serverState
                while (true) {
                    let depth = serverState.depthLevel();
                    if (serverState.canBeShownAsDecoration && depth <= maxDepth) {
                        maxDepth = depth;
                        result.push({
                            state: serverState.decorationOptions.index,
                            color: StateColors.interestingState(dark),
                            showNumber: true
                        })//push client state
                    }
                    if (serverState.isBranch()) {
                        serverState = serverState.parent;
                    } else if (!serverState.parent) {
                        break;
                    } else {
                        serverState = task.steps[serverState.index - 1];
                    }
                    task.shownExecutionTrace = result;
                }
                resolve(result);
            } catch (e) {
                Log.error("Error handling Execution Trace Request: " + e);
                resolve(result);
            }
        });
    });

    Server.connection.onRequest(Commands.StopVerification, (uri: string) => {
        return new Promise<boolean>((resolve, reject) => {
            try {
                let task = Server.verificationTasks.get(uri);
                if (task) {
                    task.abortVerificationIfRunning().then((success) => {
                        Server.sendStateChangeNotification({
                            newState: VerificationState.Ready,
                            verificationCompleted: false,
                            verificationNeeded: false,
                            uri: uri
                        }, task);
                        resolve(success);
                    })
                }
            } catch (e) {
                Log.error("Error handling stop verification request (critical): " + e);
                resolve(false);
            }
        });
    });

    Server.connection.onNotification(Commands.StopDebugging, () => {
        try {
            DebugServer.stopDebugging();
        } catch (e) {
            Log.error("Error handling stop debugging request: " + e);
        }
    })

    Server.connection.onRequest(Commands.ShowHeap, (params: ShowHeapParams) => {
        try {
            let task = Server.verificationTasks.get(params.uri);
            if (!task) {
                Log.error("No verificationTask found for " + params.uri);
                return;
            }
            Server.showHeap(task, params.clientIndex, params.isHeapNeeded);
        } catch (e) {
            Log.error("Error showing heap: " + e);
        }
    });

    Server.connection.onRequest(Commands.RemoveDiagnostics, (uri: string) => {
        //Log.log("Trying to remove diagnostics from "+ uri);
        return new Promise<boolean>((resolve, reject) => {
            if (Server.verificationTasks.has(uri)) {
                Server.verificationTasks.get(uri).resetDiagnostics();
                resolve(true);
            } else {
                resolve(false);
            }
        });
    });
}

function canVerificationBeStarted(uri: string, manuallyTriggered: boolean): boolean {
    //check if there is already a verification task for that file
    let task = Server.verificationTasks.get(uri);
    if (!task) {
        Log.error("No verification task found for file: " + uri);
        return false;
    } else if (!Server.backendService.isReady()) {
        if (manuallyTriggered) Log.hint("The verification backend is not ready yet");
        Log.error("The verification backend is not ready yet");
        return false;
    }
    return true;
}

function checkSettingsAndStartServer(backendName: string) {
    let backend;
    Settings.checkSettings(false).then(() => {
        if (Settings.valid()) {
            backend = Settings.selectBackend(Settings.settings, backendName);
            if (backend) {
                changeBackendEngineIfNeeded(backend);
                return Server.backendService.start(backend);
            } else {
                Log.error("cannot start backend " + backendName + ", no configuration found.");
                return false;
            }
        } else {
            return false;
        }
    }).then(success => {
        if (success) {
            Server.backendService.setReady(backend);
        } else {
            Server.backendService.setStopped();
            Log.log("The ViperServer could not be started.", LogLevel.Debug);
        }
    }).catch(reason => {
        if (reason.startsWith("startupFailed")) {
            Log.hint("The ViperServer startup failed, make sure the dependencies are not missing/conflicting.",true,true)
            Log.error("ViperServer: " + reason);
            Server.backendService.setStopped();
            //prevent the timeout from happening
            Server.backendService.instanceCount++;
        } else {
            Log.error("startViperServer failed: " + reason);
            Server.backendService.kill();
        }
    });
}

function changeBackendEngineIfNeeded(backend: Backend) {
    if (Settings.useViperServer(backend) && (!Server.backendService || !Server.backendService.isViperServerService)) {
        Log.log("Start new ViperServerService", LogLevel.LowLevelDebug)
        if (Server.backendService.isSessionRunning) {
            Log.error("A backend change should not happen during an active verification.")
        }
        Server.backendService = new ViperServerService();
    }
}
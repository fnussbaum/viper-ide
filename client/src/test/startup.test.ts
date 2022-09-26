import TestHelper, { CARBON, EMPTY, LONG, SETUP_TIMEOUT, SILICON, SIMPLE } from './TestHelper';

suite('Extension Startup', () => {

    suiteSetup(async function() {
        this.timeout(SETUP_TIMEOUT);
        await TestHelper.setup();
        // we do not await until a backend has been started as the first test case
        // will check this
    });

    let verified: boolean = false;
    suiteTeardown(async function() {
        if (verified) {
            // otherwise the unit test has failed anyways
            await TestHelper.teardown();
        }
    });

    test("Language Detection, and Silicon Backend Startup test.", async function() {
        this.timeout(40000);
        // this checks that silicon is the default backend
        const started = TestHelper.waitForBackendStarted(SILICON);
        await TestHelper.openFile(EMPTY);
        await started;
    });

    test("Test simple verification with Silicon", async function(){
        this.timeout(40000);
        await TestHelper.openAndVerify(SIMPLE);
        verified = true;
    });

    test("Test simple verification with Silicon and a different file", async function(){
        this.timeout(40000);
        await TestHelper.openAndVerify(EMPTY);
    });

    test("Language Detection, and Carbon Backend Startup test.", async function() {
        this.timeout(40000);
        const started = TestHelper.waitForBackendStarted(CARBON);
        TestHelper.selectBackend(CARBON);
        await TestHelper.openFile(SIMPLE);
        await started;
    });

    test("Test verification with Carbon", async function(){
        this.timeout(25000);
        await TestHelper.openAndVerify(LONG);
        // no need to switch backend back as this is the last test case of this suite.
        // TestHelper will make sure that the extension is properly restarted for the
        // next test suite.
    });
});

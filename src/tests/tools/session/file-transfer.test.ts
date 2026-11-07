import {describe, test, expect, jest, beforeEach} from '@jest/globals';

jest.unstable_mockModule('../../../persistence', () => ({
  isSessionPersistenceEnabled: jest.fn(() => false),
  readAllPersistedSessions: jest.fn(async () => []),
  removePersistedSession: jest.fn(async () => {}),
  writePersistedSession: jest.fn(async () => {}),
}));
jest.unstable_mockModule('../../../session-store', () => ({
  listPersistedSessions: jest.fn(() => []),
  removePersistedSession: jest.fn(),
  setSession: jest.fn(),
  getDriver: jest.fn(),
  getPlatformName: jest.fn(),
  PLATFORM: {ios: 'iOS', android: 'Android'},
}));

jest.unstable_mockModule('../../../command', () => ({
  execute: jest.fn(),
}));

jest.unstable_mockModule('../../../logger', () => ({
  default: {debug: () => {}, info: () => {}, warn: () => {}, error: () => {}},
}));

const {getDriver, getPlatformName, PLATFORM} = await import('../../../session-store.js');
const {execute} = await import('../../../command.js');

const mockGetDriver = getDriver as jest.MockedFunction<typeof getDriver>;
const mockGetPlatformName = getPlatformName as jest.MockedFunction<typeof getPlatformName>;
const mockExecute = execute as jest.MockedFunction<typeof execute>;

describe('appium_mobile_file', () => {
  const mockServer = {addTool: jest.fn()} as any;

  beforeEach(() => {
    (mockServer.addTool as jest.MockedFunction<any>).mockClear();
    mockExecute.mockReset();
  });

  /**
   * push is a destructive operation (it overwrites device files), so the first call only returns a confirmation token.
   * The original assertions below are unchanged; they now run after the second, confirmed call.
   */
  async function confirmedPush(tool: any, args: Record<string, unknown>) {
    const first = await tool.execute(args, undefined);
    expect(first.isError).toBe(true);
    expect(first.content[0].text).toMatch(/CONFIRMATION REQUIRED/);
    expect(mockExecute).not.toHaveBeenCalled();
    const token = /confirmToken="([0-9a-f]+)"/.exec(first.content[0].text)?.[1];
    expect(token).toBeTruthy();
    return tool.execute({...args, confirmToken: token}, undefined);
  }

  async function registerTool() {
    const {default: fileTransfer} = await import('../../../tools/session/file-transfer.js');
    fileTransfer(mockServer);
    return (mockServer.addTool as jest.MockedFunction<any>).mock.calls.at(-1)?.[0];
  }

  test('returns error when no driver is active', async () => {
    const tool = await registerTool();
    mockGetDriver.mockReturnValue(null as any);

    const result = await tool.execute({action: 'push', remotePath: '/sdcard/x.txt', payloadBase64: 'YQ=='}, undefined);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(
      'No active driver session. Use appium_session_management (action=create or action=attach), or pass a valid sessionId.',
    );
  });

  test('returns error with sessionId when no driver is active for that session', async () => {
    const tool = await registerTool();

    const result = await tool.execute(
      {
        action: 'push',
        remotePath: '/sdcard/x.txt',
        payloadBase64: 'YQ==',
        sessionId: 'session-123',
      },
      undefined,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(
      "No active driver session for session 'session-123'. Use appium_session_management (action=create or action=attach), or pass a valid sessionId.",
    );
  });

  test('push: Android uses remotePath and payload', async () => {
    const tool = await registerTool();
    mockGetDriver.mockReturnValue({} as any);
    mockGetPlatformName.mockReturnValue(PLATFORM.android);
    mockExecute.mockResolvedValue(undefined);

    await confirmedPush(tool, {
      action: 'push',
      remotePath: '/data/local/tmp/a.txt',
      payloadBase64: 'SGVsbG8=',
    });

    expect(mockExecute).toHaveBeenCalledWith(expect.anything(), 'mobile: pushFile', {
      remotePath: '/data/local/tmp/a.txt',
      payload: 'SGVsbG8=',
    });
  });

  test('push: iOS uses remotePath and payload', async () => {
    const tool = await registerTool();
    mockGetDriver.mockReturnValue({} as any);
    mockGetPlatformName.mockReturnValue(PLATFORM.ios);
    mockExecute.mockResolvedValue(undefined);

    await confirmedPush(tool, {
      action: 'push',
      remotePath: '@com.example.app:documents/x.txt',
      payloadBase64: 'QQ==',
    });

    expect(mockExecute).toHaveBeenCalledWith(expect.anything(), 'mobile: pushFile', {
      remotePath: '@com.example.app:documents/x.txt',
      payload: 'QQ==',
    });
  });

  test('push without a token writes nothing, and a token cannot be reused or moved to another path', async () => {
    const tool = await registerTool();
    mockGetDriver.mockReturnValue({} as any);
    mockGetPlatformName.mockReturnValue(PLATFORM.android);
    mockExecute.mockResolvedValue(undefined);
    const args = {action: 'push', remotePath: '/sdcard/a.txt', payloadBase64: 'QQ=='};

    const first = await tool.execute(args, undefined);
    expect(first.isError).toBe(true);
    expect(mockExecute).not.toHaveBeenCalled();
    const token = /confirmToken="([0-9a-f]+)"/.exec(first.content[0].text)?.[1];

    const moved = await tool.execute({...args, remotePath: '/sdcard/OTHER.txt', confirmToken: token}, undefined);
    expect(moved.isError).toBe(true);
    expect(mockExecute).not.toHaveBeenCalled();

    const ok = await tool.execute({...args, confirmToken: token}, undefined);
    expect(ok.isError).toBeUndefined();
    expect(mockExecute).toHaveBeenCalledTimes(1);

    const reused = await tool.execute({...args, confirmToken: token}, undefined);
    expect(reused.isError).toBe(true);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  test('pull is read-only and needs no confirmation', async () => {
    const tool = await registerTool();
    mockGetDriver.mockReturnValue({} as any);
    mockGetPlatformName.mockReturnValue(PLATFORM.android);
    mockExecute.mockResolvedValue('eHh4');
    const result = await tool.execute({action: 'pull', remotePath: '/sdcard/x.txt'}, undefined);
    expect(result.isError).toBeUndefined();
  });

  test('pull: Android uses remotePath', async () => {
    const tool = await registerTool();
    mockGetDriver.mockReturnValue({} as any);
    mockGetPlatformName.mockReturnValue(PLATFORM.android);
    mockExecute.mockResolvedValue('YmJiYg==');

    const result = await tool.execute({action: 'pull', remotePath: '/sdcard/Download/out.bin'}, undefined);

    expect(mockExecute).toHaveBeenCalledWith(expect.anything(), 'mobile: pullFile', {
      remotePath: '/sdcard/Download/out.bin',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.contentBase64).toBe('YmJiYg==');
    expect(parsed.platform).toBe('Android');
  });

  test('push: a non-Android/iOS session still calls the driver', async () => {
    const tool = await registerTool();
    mockGetDriver.mockReturnValue({} as any);
    mockGetPlatformName.mockReturnValue('Windows');
    mockExecute.mockResolvedValue(undefined);

    const result = await confirmedPush(tool, {
      action: 'push',
      remotePath: 'C:\\temp\\a.txt',
      payloadBase64: 'QQ==',
    });

    expect(result.isError).toBeUndefined();
    expect(mockExecute).toHaveBeenCalledWith(expect.anything(), 'mobile: pushFile', {
      remotePath: 'C:\\temp\\a.txt',
      payload: 'QQ==',
    });
  });

  test('pull: iOS uses remotePath', async () => {
    const tool = await registerTool();
    mockGetDriver.mockReturnValue({} as any);
    mockGetPlatformName.mockReturnValue(PLATFORM.ios);
    mockExecute.mockResolvedValue('eHh4');

    const result = await tool.execute({action: 'pull', remotePath: '@com.app:documents/f.txt'}, undefined);

    expect(mockExecute).toHaveBeenCalledWith(expect.anything(), 'mobile: pullFile', {
      remotePath: '@com.app:documents/f.txt',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.contentBase64).toBe('eHh4');
    expect(parsed.platform).toBe('iOS');
  });
});

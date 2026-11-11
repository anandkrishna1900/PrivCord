import { describe, expect, it } from 'vitest';
import { HostedEngine, type EngineBridge } from './engineBridge';

/** A fake engine: records calls in order, and can answer "Busy" a few times first. */
function fakeBridge(busyFirst = 0) {
  const calls: string[] = [];
  let busyLeft = busyFirst;
  const bridge: EngineBridge = {
    start: async () => undefined,
    stop: async () => undefined,
    invoke: async (command, args = {}) => {
      if (command === 'frame_received' && busyLeft > 0) {
        busyLeft -= 1;
        throw new Error('Busy');
      }
      calls.push(`${command}:${JSON.stringify(args)}`);
      return null;
    },
    on: async () => () => undefined,
  };
  return { bridge, calls };
}

describe('HostedEngine inbound calls', () => {
  it('reach the engine strictly in the order they were made', async () => {
    const { bridge, calls } = fakeBridge();
    const engine = new HostedEngine(bridge);
    await Promise.all([
      engine.linkUp('p', 'direct_lan', 'encrypted'),
      engine.frameReceived('p', 'a'),
      engine.frameReceived('p', 'b'),
      engine.frameReceived('p', 'c'),
      engine.linkDown('p'),
    ]);
    expect(calls.map((c) => c.split(':')[0])).toEqual(['link_up', 'frame_received', 'frame_received', 'frame_received', 'link_down']);
    expect(calls.filter((c) => c.startsWith('frame_received')).map((c) => JSON.parse(c.slice(15)).frame)).toEqual(['a', 'b', 'c']);
  });

  it('retries a frame while the engine is busy instead of dropping it, and keeps the order', async () => {
    const { bridge, calls } = fakeBridge(3);
    const engine = new HostedEngine(bridge);
    await Promise.all([engine.frameReceived('p', 'first'), engine.frameReceived('p', 'second')]);
    expect(calls.map((c) => JSON.parse(c.slice(15)).frame)).toEqual(['first', 'second']);
  });

  it('does not let one failed call stop the ones behind it', async () => {
    const calls: string[] = [];
    const bridge: EngineBridge = {
      start: async () => undefined,
      stop: async () => undefined,
      invoke: async (command, args = {}) => {
        if ((args as { frame?: string }).frame === 'bad') throw new Error('InvalidArgument');
        calls.push(command);
        return null;
      },
      on: async () => () => undefined,
    };
    const engine = new HostedEngine(bridge);
    const bad = engine.frameReceived('p', 'bad');
    const good = engine.frameReceived('p', 'good');
    await expect(bad).rejects.toThrow('InvalidArgument');
    await good;
    expect(calls).toEqual(['frame_received']);
  });
});

import { describe, expect, it } from 'vitest';
import { acceptsDirect, canStartDirect, type ContactTrustLevel } from '../src';

/** Seven people in one group. `paired` lists who swapped invites; everyone else only knows each other via the group. */
function world(names: string[], optedOut: string[], pairs: [string, string][]) {
  const paired = new Set(pairs.map(([a, b]) => [a, b].sort().join('|')));
  const trust = (me: string, other: string): ContactTrustLevel => (paired.has([me, other].sort().join('|')) ? 'verified' : 'introduced');
  const out = (n: string) => optedOut.includes(n);
  /** x can send y a direct message that y accepts. */
  const dm = (x: string, y: string) =>
    canStartDirect(trust(x, y), out(x), out(y)) && acceptsDirect(trust(y, x), out(y));
  const matrix: Record<string, string[]> = {};
  for (const x of names) matrix[x] = names.filter((y) => y !== x && dm(x, y));
  return { dm, matrix };
}

const G = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];

describe('group-only privacy opt-out', () => {
  it('A opted out and paired only with C and F: only they can message A', () => {
    const { dm, matrix } = world(G, ['A'], [['A', 'C'], ['A', 'F']]);
    for (const x of ['C', 'F']) {
      expect(dm(x, 'A')).toBe(true);
      expect(dm('A', x)).toBe(true);
    }
    for (const x of ['B', 'D', 'E', 'G']) {
      expect(dm(x, 'A')).toBe(false);
      expect(dm('A', x)).toBe(false);
    }
    // everybody else is unaffected: they chat with each other by default
    for (const x of ['B', 'C', 'D', 'E', 'F', 'G']) {
      for (const y of ['B', 'C', 'D', 'E', 'F', 'G']) if (x !== y) expect(matrix[x]).toContain(y);
    }
  });

  it('B, D, E and G can message A once they pair with A themselves', () => {
    const { dm } = world(G, ['A'], [['A', 'C'], ['A', 'F'], ['A', 'D']]);
    expect(dm('D', 'A')).toBe(true);
    expect(dm('A', 'D')).toBe(true);
    expect(dm('B', 'A')).toBe(false);
  });

  it('with nobody opted out, everyone in the group can message everyone', () => {
    const { matrix } = world(G, [], []);
    for (const x of G) expect(matrix[x]).toHaveLength(6);
  });

  it('opt-outs by several people: only manually paired pairs (or both-open pairs) can chat', () => {
    const { dm } = world(G, ['A', 'B'], [['A', 'B'], ['C', 'D']]);
    expect(dm('A', 'B')).toBe(true); // both opted out but paired by hand
    expect(dm('A', 'C')).toBe(false);
    expect(dm('B', 'D')).toBe(false);
    expect(dm('C', 'D')).toBe(true);
    expect(dm('C', 'E')).toBe(true); // neither opted out
  });

  it('is symmetric when both sides pair, and a one-sided pairing needs the other to accept', () => {
    // A opted out and added C's invite, but C never added A (C is not opted out).
    const trustA = (o: string): ContactTrustLevel => (o === 'C' ? 'verified' : 'introduced');
    const trustC = (): ContactTrustLevel => 'introduced';
    // A -> C: A sees C as verified so may start; C (open) accepts introduced people.
    expect(canStartDirect(trustA('C'), true, false) && acceptsDirect(trustC(), false)).toBe(true);
    // C -> A: C may start (nobody told C otherwise) but A (opted out) only accepts verified: C is verified at A.
    expect(acceptsDirect(trustA('C'), true)).toBe(true);
    // If C is opted out too and has not paired back, A's message is refused by C.
    expect(acceptsDirect(trustC(), true)).toBe(false);
  });

  it('knowing the peer opted out stops the attempt before anything is sent', () => {
    expect(canStartDirect('introduced', false, true)).toBe(false);
    expect(canStartDirect('introduced', false, false)).toBe(true);
    expect(canStartDirect('introduced', false, undefined)).toBe(true);
    expect(canStartDirect('verified', true, true)).toBe(true);
  });
});

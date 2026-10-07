import { describe, expect, it } from 'vitest';
import { monsterBreathHush, monsterStepStyle } from './monster';

describe('monster sound follows its body language', () => {
  it('creeping steps are near-silent, crawling knocks, walking and running are full steps', () => {
    const walk = monsterStepStyle({ gait: 'walk', posture: 'tall' });
    const run = monsterStepStyle({ gait: 'run', posture: 'duck' });
    const creep = monsterStepStyle({ gait: 'creep', posture: 'tall' });
    const crawl = monsterStepStyle({ gait: 'walk', posture: 'crawl' });
    expect(walk).toMatchObject({ level: 1, crawl: false });
    expect(run).toMatchObject({ level: 1, crawl: false });
    expect(creep.level).toBeLessThan(0.2);
    expect(creep.crawl).toBe(false);
    expect(crawl.crawl).toBe(true);
    expect(monsterStepStyle({ gait: 'creep', posture: 'crawl' }).level).toBeLessThan(crawl.level);
  });

  it('holds its breath to listen, barely breathes while lurking, pants in a chase', () => {
    const base = { gait: 'walk', act: 'none', mode: 'wander' } as const;
    expect(monsterBreathHush(base)).toBe(1);
    expect(monsterBreathHush({ ...base, act: 'listen' })).toBeLessThan(0.6);
    expect(monsterBreathHush({ ...base, act: 'lurk' })).toBeLessThan(monsterBreathHush({ ...base, act: 'listen' }));
    expect(monsterBreathHush({ ...base, gait: 'creep' })).toBeLessThan(1);
    expect(monsterBreathHush({ ...base, act: 'listen', mode: 'chase' })).toBe(1);
  });
});

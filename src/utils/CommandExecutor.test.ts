import { describe, expect, it } from 'vitest';
import { CommandExecutor } from './CommandExecutor';

describe('CommandExecutor', () => {
  it('is defined and returns a singleton instance', () => {
    const first = CommandExecutor.getInstance();
    const second = CommandExecutor.getInstance();
    expect(first).toBeInstanceOf(CommandExecutor);
    expect(second).toBe(first);
  });
});

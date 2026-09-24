// Claude Code function hook: under a turn's closing line, orly's last verdict as a bar
// and the top three things behind it. adapter.ts writes ~/.orly/status/<session>.json
// on every Stop; this module only reads and draws it.
import type { Register } from 'claude-code';

export const register: Register = (on) => {
  // The Stop hook finishes after the line may already be drawn: draw again once it has.
  on('classic.Stop', async ($, e, next) => {
    const r = await next(e);
    void $.ui.invalidate('ui.render');
    return r;
  });

  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    const drawn = await next(e);
    let s: { pct: number | null; blocked: boolean; items: string[] };
    try {
      s = JSON.parse(String(await $.fs.read(`${await $.env.get('HOME')}/.orly/status/${await $.session.id()}.json`)));
    } catch {
      return drawn;
    }
    const { Box, Text } = $.ui.resolve(e);
    const width = Math.max(10, Math.min(30, (e.viewport?.columns ?? 80) - 40));
    const pct = s.pct ?? 0;
    const full = Math.round((pct / 100) * width);
    const color = s.blocked || pct < 50 ? 'red' : pct < 80 ? 'yellow' : 'green';
    return Box({ flexDirection: 'column', children: [
      drawn,
      Text({ children: [
        '  ',
        Text({ color, children: '█'.repeat(full) }),
        Text({ dimColor: true, children: `${'░'.repeat(width - full)} orly? ${s.pct === null ? '–' : `${pct}%`}${s.blocked ? ' · blocked' : ''}` }),
      ] }),
      ...s.items.map((item) => Text({ dimColor: true, children: `    ${item}` })),
    ] });
  });
};

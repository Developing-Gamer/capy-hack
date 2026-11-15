import type { Limb } from './protocol';

const LIMB_LABEL: Record<Limb, string> = { ra: 'R.ARM', la: 'L.ARM', rl: 'R.LEG', ll: 'L.LEG' };
const el = (tag: string, cls: string, parent: HTMLElement, html = '') => {
  const e = document.createElement(tag);
  e.className = cls;
  e.innerHTML = html;
  parent.appendChild(e);
  return e;
};

export interface BoardRow {
  name: string;
  value: number;
  max: number;
  me?: boolean;
  dead?: boolean;
  done?: boolean;
}

export interface Assessment {
  kicker: string;
  subject: string;
  verdict: 'RETAINED' | 'TERMINATED';
  lines: [string, string][];
  remark: string;
  table: string[];
  fine: string;
}

/** DOM HUD over the canvas: timer, pot, limbs, status, scoreboard, feed, intro and assessment cards. */
export class Hud {
  readonly root: HTMLElement;
  private timer: HTMLElement;
  private pot: HTMLElement;
  private title: HTMLElement;
  private limbs: HTMLElement;
  private status: HTMLElement;
  private board: HTMLElement;
  private feedEl: HTMLElement;
  private hint: HTMLElement;
  private overlay: HTMLElement;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'hud', parent);
    const top = el('div', 'top', this.root);
    const left = el('div', 'tl', top);
    this.title = el('div', 'title', left);
    this.limbs = el('div', 'limbs', left);
    const right = el('div', 'tr', top);
    this.timer = el('div', 'timer', right, '0:00');
    this.pot = el('div', 'pot', right);
    this.status = el('div', 'status', this.root);
    this.board = el('div', 'board', this.root);
    this.feedEl = el('div', 'feed', this.root);
    this.hint = el('div', 'hint', this.root);
    this.overlay = el('div', 'overlay', parent);
  }

  setTitle(kicker: string, name: string) {
    this.title.innerHTML = `<small>${kicker}</small>${name}`;
  }

  setTimer(seconds: number) {
    const s = Math.max(0, Math.ceil(seconds));
    this.timer.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    this.timer.classList.toggle('low', seconds < 10);
  }

  setPot(dollars: number | undefined) {
    this.pot.textContent = dollars === undefined ? '' : `POT $${dollars}`;
  }

  setLimbs(limbs: Limb[]) {
    this.limbs.innerHTML = (['la', 'ra', 'll', 'rl'] as Limb[]).map((l) => `<i class="${limbs.includes(l) ? '' : 'gone'}">${LIMB_LABEL[l]}</i>`).join('');
  }

  setStatus(text: string, mode: 'calm' | 'warn' | 'danger' | 'hidden' = 'calm') {
    if (this.status.textContent !== text) this.status.textContent = text;
    this.status.className = 'status ' + mode;
  }

  setBoard(rows: BoardRow[]) {
    this.board.innerHTML = rows
      .map(
        (r) =>
          `<div class="row ${r.me ? 'me' : ''} ${r.dead ? 'dead' : ''} ${r.done ? 'done' : ''}"><b>${r.name}</b><span class="bar"><i style="width:${Math.min(100, (r.value / r.max) * 100)}%"></i></span><em>${r.dead ? 'DEAD' : r.done ? 'EXCUSED' : `${r.value}/${r.max}`}</em></div>`,
      )
      .join('');
  }

  feed(html: string) {
    const line = el('div', 'line', this.feedEl, html);
    setTimeout(() => line.classList.add('out'), 3200);
    setTimeout(() => line.remove(), 3800);
  }

  setHint(html: string) {
    this.hint.innerHTML = html;
  }

  /** Big stamped word across the screen (e.g. TERMINATED). */
  stamp(text: string) {
    const s = el('div', 'stamp', this.root, text);
    requestAnimationFrame(() => s.classList.add('in'));
  }

  /** Rules card; resolves on the first tap. */
  intro(kicker: string, title: string, rules: string[]) {
    this.overlay.className = 'overlay show intro';
    this.overlay.innerHTML = `<div class="card"><small>${kicker}</small><h1>${title}</h1><ol>${rules.map((r) => `<li>${r}</li>`).join('')}</ol><div class="cta">TAP TO BEGIN</div></div>`;
    return new Promise<void>((resolve) => {
      const go = (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        this.overlay.removeEventListener('pointerdown', go);
        window.removeEventListener('keydown', go);
        this.overlay.className = 'overlay';
        resolve();
      };
      this.overlay.addEventListener('pointerdown', go);
      window.addEventListener('keydown', go);
    });
  }

  /** The cold clinical card at the end of a round. */
  assessment(a: Assessment) {
    this.overlay.className = 'overlay show assess ' + (a.verdict === 'TERMINATED' ? 'term' : 'kept');
    this.overlay.innerHTML = `<div class="card">
      <small>${a.kicker}</small>
      <h2>${a.subject}</h2>
      <div class="verdict">${a.verdict}</div>
      <dl>${a.lines.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
      <p class="remark">${a.remark}</p>
      <ol class="table">${a.table.map((t) => `<li>${t}</li>`).join('')}</ol>
      <div class="fine">${a.fine}</div>
    </div>`;
  }
}

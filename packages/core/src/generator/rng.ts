const ALNUM = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** FNV-1a 32-bit hash, used to derive independent sub-streams from a seed + label. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Seeded PRNG (mulberry32). The generator never touches Math.random or the clock. */
export class Rng {
  private state: number;

  constructor(private readonly seed: number) {
    this.state = seed >>> 0;
  }

  /**
   * Independent stream for one generator stage, so changing one stage
   * doesn't reshuffle every other stage's output.
   */
  fork(label: string): Rng {
    return new Rng(fnv1a(`${this.seed}:${label}`));
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max], inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  uniform(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("pick from empty array");
    return items[this.int(0, items.length - 1)] as T;
  }

  weighted<K extends string>(weights: Readonly<Record<K, number>>): K {
    const entries = Object.entries(weights) as [K, number][];
    const total = entries.reduce((s, [, w]) => s + w, 0);
    let r = this.next() * total;
    for (const [key, w] of entries) {
      r -= w;
      if (r < 0) return key;
    }
    return (entries[entries.length - 1] as [K, number])[0];
  }

  /** Fisher-Yates on a copy. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [out[i], out[j]] = [out[j] as T, out[i] as T];
    }
    return out;
  }

  sample<T>(items: readonly T[], k: number): T[] {
    return this.shuffle(items).slice(0, Math.max(0, k));
  }

  alnum(length: number, alphabet: string = ALNUM): string {
    let s = "";
    for (let i = 0; i < length; i++) s += alphabet[this.int(0, alphabet.length - 1)];
    return s;
  }

  digits(length: number): string {
    return this.alnum(length, "0123456789");
  }
}

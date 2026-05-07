// Tracks per-sermon, per-section AI write vs. user edit timestamps so the
// system-prompt assembler can flag sections the pastor has touched directly
// since the AI's last write. In-memory only; restart loses the trail (fine
// for v1 — restart implies a clean slate).

export interface EditTracker {
  recordAiWrite(slug: string, section: string): void;
  recordUserEdit(slug: string, section: string): void;
  /**
   * Sections in the given sermon where the user's last edit timestamp is
   * strictly greater than the AI's last write timestamp (or where the AI
   * has never written and the user has). Returned in stable section-name
   * order.
   */
  sectionsEditedAheadOfAi(slug: string): string[];
}

interface SectionState {
  ai_at: number;
  user_at: number;
}

function nowMonotonic(): number {
  // performance.now() is monotonic but JS Date.now() is enough for this and
  // is universally available without `node:perf_hooks` import in this layer.
  return Date.now();
}

export function createEditTracker(): EditTracker {
  const slugs = new Map<string, Map<string, SectionState>>();

  function getSermon(slug: string): Map<string, SectionState> {
    let map = slugs.get(slug);
    if (!map) {
      map = new Map();
      slugs.set(slug, map);
    }
    return map;
  }

  function getOrCreateSection(slug: string, section: string): SectionState {
    const sermon = getSermon(slug);
    let state = sermon.get(section);
    if (!state) {
      state = { ai_at: 0, user_at: 0 };
      sermon.set(section, state);
    }
    return state;
  }

  return {
    recordAiWrite(slug, section) {
      const state = getOrCreateSection(slug, section);
      state.ai_at = nowMonotonic();
    },
    recordUserEdit(slug, section) {
      const state = getOrCreateSection(slug, section);
      state.user_at = nowMonotonic();
    },
    sectionsEditedAheadOfAi(slug) {
      const sermon = slugs.get(slug);
      if (!sermon) {
        return [];
      }
      const ahead: string[] = [];
      for (const [section, state] of sermon.entries()) {
        if (state.user_at > state.ai_at) {
          ahead.push(section);
        }
      }
      return ahead.sort();
    }
  };
}

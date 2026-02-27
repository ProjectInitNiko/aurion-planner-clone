const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

let supabase = null;

if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  console.log('[supabase] Connected to Supabase');
} else {
  console.warn('[supabase] Missing SUPABASE_URL or SUPABASE_SERVICE_KEY — caching disabled');
}

/**
 * Get cached events for a user
 * @param {string} username
 * @returns {Promise<{events: Array, lastUpdated: string} | null>}
 */
async function getCachedEvents(username) {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('user_events')
      .select('events, last_updated')
      .eq('username', username)
      .single();

    if (error || !data) return null;
    return { events: data.events, lastUpdated: data.last_updated };
  } catch (e) {
    console.error('[supabase] getCachedEvents error:', e.message);
    return null;
  }
}

/**
 * Save events to cache (upsert)
 * @param {string} username
 * @param {Array} events
 */
async function saveEvents(username, events) {
  if (!supabase) return;
  try {
    const { error } = await supabase
      .from('user_events')
      .upsert(
        {
          username,
          events,
          last_updated: new Date().toISOString(),
        },
        { onConflict: 'username' }
      );

    if (error) {
      console.error('[supabase] saveEvents error:', error.message);
    } else {
      console.log(`[supabase] Saved ${events.length} events for ${username}`);
    }
  } catch (e) {
    console.error('[supabase] saveEvents error:', e.message);
  }
}

/**
 * Check if cache is fresh (less than maxAgeHours old)
 * @param {string} lastUpdated
 * @param {number} maxAgeHours
 * @returns {boolean}
 */
function isCacheFresh(lastUpdated, maxAgeHours = 2) {
  if (!lastUpdated) return false;
  const cacheTime = new Date(lastUpdated).getTime();
  const now = Date.now();
  return (now - cacheTime) < maxAgeHours * 60 * 60 * 1000;
}

module.exports = { getCachedEvents, saveEvents, isCacheFresh };

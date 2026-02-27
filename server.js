const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const convert = require('xml-js');
const path = require('path');
const { getCachedEvents, saveEvents, isCacheFresh } = require('./supabaseClient');

const app = express();
const PORT = 3001;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// Serve static frontend files (index.html, style.css, main.js)
app.use(express.static(path.join(__dirname)));

// Store active browser sessions (in-memory, keyed by a simple session token)
const sessions = new Map();

// Clean up sessions older than 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (now - session.lastUsed > 30 * 60 * 1000) {
      session.browser.close().catch(() => { });
      sessions.delete(token);
      console.log(`[cleanup] Session ${token.substring(0, 8)}... expired`);
    }
  }
}, 5 * 60 * 1000);

/**
 * Generate a simple random token
 */
function generateToken() {
  return Array.from({ length: 32 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join('');
}

/**
 * Parse the event title from Aurion into structured data.
 * Aurion titles typically look like:
 *   "LINE1\nLINE2\nLINE3\n..."
 * Where lines contain: course name, professor, room, group, etc.
 */
function parseEventTitle(title) {
  if (!title) return { courseName: 'Sans titre', room: '', professor: '', raw: '' };

  const lines = title.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  let courseName = '';
  let room = '';
  let professor = '';
  let group = '';
  const rawLines = [...lines];

  // Try to extract room (usually contains a room-like pattern)
  const roomPatterns = [
    /^[A-Z]?\d{3}[A-Z]?$/,           // e.g. A301, 204, 301B
    /salle/i,                          // contains "salle"
    /amphi/i,                          // amphitheatre
    /labo/i,                           // laboratory
    /^[A-Z]{1,3}[-\s]?\d{1,4}$/,      // e.g. B-201, TD3
  ];

  // Try to extract professor (usually "Prénom NOM" or "M. NOM" pattern)
  const profPatterns = [
    /^(M\.|Mme|Mr|Pr|Dr)\s/i,
    /^[A-ZÉÈÊËÀÂÄÙÛÜÔÖÏÎ][a-zéèêëàâäùûüôöïî]+\s[A-ZÉÈÊËÀÂÄÙÛÜÔÖÏÎ]{2,}/,  // "Prénom NOM"
  ];

  for (const line of lines) {
    if (!room && roomPatterns.some(p => p.test(line))) {
      room = line;
    } else if (!professor && profPatterns.some(p => p.test(line))) {
      professor = line;
    } else if (!courseName) {
      courseName = line;
    } else if (!group) {
      group = line;
    }
  }

  // If nothing matched as course name, use the first line
  if (!courseName && lines.length > 0) {
    courseName = lines[0];
  }

  return {
    courseName: courseName || 'Sans titre',
    room: room || '',
    professor: professor || (lines.length > 2 ? lines[lines.length - 1] : ''),
    group: group || '',
    raw: title,
  };
}

/**
 * Determine event type from className or title
 */
function getEventType(className, title) {
  const cl = (className || '').toLowerCase();
  const t = (title || '').toLowerCase();

  if (cl.includes('epreuve') || cl.includes('exam') || t.includes('examen') || t.includes('partiel') || t.includes('épreuve')) return 'exam';
  if (t.includes(' td') || t.includes('td ') || cl.includes('td')) return 'td';
  if (t.includes(' tp') || t.includes('tp ') || cl.includes('tp')) return 'tp';
  if (t.includes(' cm') || t.includes('cm ') || t.includes('cours magistral') || cl.includes('cm')) return 'cm';
  if (t.includes('projet') || cl.includes('projet')) return 'projet';
  if (t.includes('réunion') || t.includes('reunion')) return 'reunion';
  return 'cours';
}

/**
 * POST /api/login-and-fetch
 * Body: { username, password }
 * Returns: { token, events: [...], period: { start, end } }
 */
app.post('/api/login-and-fetch', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Identifiant et mot de passe requis' });
  }

  // Check Supabase cache first
  try {
    const cached = await getCachedEvents(username);
    if (cached && isCacheFresh(cached.lastUpdated, 2)) {
      console.log(`[login] Returning ${cached.events.length} cached events for ${username} (fresh)`);
      return res.json({
        token: generateToken(),
        events: cached.events,
        fromCache: true,
        cachedAt: cached.lastUpdated,
        message: `${cached.events.length} événements (cache). Données mises à jour il y a moins de 2h.`,
      });
    }
  } catch (e) {
    console.warn('[login] Cache check failed, proceeding with Aurion:', e.message);
  }

  let browser;
  try {
    console.log(`[login] Launching browser for ${username}...`);

    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });

    const page = await browser.newPage();

    // Set French locale to ensure room numbers are displayed
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'fr-FR,fr;q=0.9' });
    await page.setViewport({ width: 1920, height: 1080 });

    // Navigate to login page
    console.log('[login] Navigating to Aurion login page...');
    await page.goto('https://scolarite.supmeca.fr/faces/Login.xhtml', {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    // Fill login form
    await page.type('#username', username);
    await page.type('#password', password);

    // Submit
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }),
      page.keyboard.press('Enter'),
    ]);

    // Check if login was successful
    const currentUrl = page.url();
    if (currentUrl.includes('login') || currentUrl.includes('Login')) {
      // Check if we're still on the login page (error)
      const errorMsg = await page.evaluate(() => {
        const errEl = document.querySelector('.ui-messages-error, .error-message, .alert-danger, #message-erreur');
        return errEl ? errEl.textContent.trim() : null;
      });
      await browser.close();
      return res.status(401).json({
        error: errorMsg || 'Identifiants incorrects. Vérifiez votre login et mot de passe.',
      });
    }

    console.log('[login] Login successful, navigating to planning...');

    // Navigate to "Mon Planning"
    // Try clicking the menu item with text "Mon Planning" or "Planning"
    await page.waitForSelector('li > a > span', { timeout: 15000 });

    const planningClicked = await page.evaluate(() => {
      const spans = document.querySelectorAll('li > a > span');
      for (const span of spans) {
        const text = span.textContent.trim().toLowerCase();
        if (text.includes('planning') || text.includes('emploi du temps') || text.includes('mon planning')) {
          span.click();
          return true;
        }
      }
      // Also try direct menu links
      const links = document.querySelectorAll('a');
      for (const link of links) {
        const text = link.textContent.trim().toLowerCase();
        if (text.includes('planning') || text.includes('emploi du temps')) {
          link.click();
          return true;
        }
      }
      return false;
    });

    if (!planningClicked) {
      // Try to find the planning page through navigation
      const menuItems = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('li > a > span')).map(s => s.textContent.trim());
      });
      console.log('[login] Available menu items:', menuItems);
      await browser.close();
      return res.status(500).json({
        error: 'Impossible de trouver le menu "Mon Planning". Menus disponibles: ' + menuItems.join(', '),
      });
    }

    // Wait for the planning page to load
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => { });
    await new Promise(resolve => setTimeout(resolve, 5000));

    console.log('[login] Planning page loaded, extracting events...');

    // Try to switch to month view if available
    const monthButton = await page.$('.fc-right > button.fc-month-button, .fc-month-button, button[title="mois"], button[title="Mois"]');
    if (monthButton) {
      await monthButton.click();
      await new Promise(resolve => setTimeout(resolve, 3000));
    }

    // Set up response interceptor for calendar data
    let calendarEvents = [];

    // Method 1: Try to extract events directly from FullCalendar's internal data
    calendarEvents = await page.evaluate(() => {
      // FullCalendar v3/v4/v5 - try to get events from the calendar object
      const calEl = document.querySelector('.fc, [class*="fullcalendar"], #calendar, .schedule-calendar');
      if (calEl) {
        // Try jQuery-based FullCalendar (v3)
        if (typeof jQuery !== 'undefined' || typeof $ !== 'undefined') {
          try {
            const $cal = (typeof jQuery !== 'undefined' ? jQuery : $)(calEl);
            const fc = $cal.fullCalendar || $cal.data('fullCalendar');
            if (fc) {
              const events = $cal.fullCalendar('clientEvents');
              return events.map(e => ({
                id: e.id || e._id,
                title: e.title || '',
                start: e.start ? (e.start.toISOString ? e.start.toISOString() : e.start.format ? e.start.format() : String(e.start)) : '',
                end: e.end ? (e.end.toISOString ? e.end.toISOString() : e.end.format ? e.end.format() : String(e.end)) : '',
                className: typeof e.className === 'string' ? e.className : (Array.isArray(e.className) ? e.className.join(' ') : ''),
                allDay: e.allDay || false,
              }));
            }
          } catch (e) { /* ignore */ }
        }
      }
      return [];
    });

    // Method 2: If no events found, try to intercept by navigating months
    if (calendarEvents.length === 0) {
      console.log('[login] Method 1 failed, trying response interception...');

      // Set up response listener
      const eventPromise = new Promise((resolve) => {
        const timeout = setTimeout(() => resolve([]), 15000);

        page.on('response', async (response) => {
          try {
            const contentType = response.headers()['content-type'] || '';
            if (contentType.includes('xml') || contentType.includes('json')) {
              const text = await response.text();

              // Try XML parsing (Aurion uses JSF partial responses)
              if (contentType.includes('xml') && text.includes('partial-response')) {
                try {
                  const jsonResult = JSON.parse(convert.xml2json(text, { compact: true, spaces: 2 }));
                  const updates = jsonResult['partial-response']?.['changes']?.['update'];
                  if (updates) {
                    const updateArray = Array.isArray(updates) ? updates : [updates];
                    for (const update of updateArray) {
                      const cdata = update['_cdata'];
                      if (cdata) {
                        try {
                          const parsed = JSON.parse(cdata);
                          if (parsed.events && Array.isArray(parsed.events)) {
                            clearTimeout(timeout);
                            resolve(parsed.events);
                            return;
                          }
                        } catch (e) { /* not JSON */ }
                      }
                    }
                  }
                } catch (e) { /* not valid xml */ }
              }

              // Try direct JSON
              if (contentType.includes('json')) {
                try {
                  const parsed = JSON.parse(text);
                  if (parsed.events && Array.isArray(parsed.events)) {
                    clearTimeout(timeout);
                    resolve(parsed.events);
                    return;
                  }
                } catch (e) { /* not JSON */ }
              }
            }
          } catch (e) { /* ignore */ }
        });
      });

      // Trigger a calendar navigation to generate a response
      const nextButton = await page.$('.fc-next-button, .fc-right > .fc-button-group > button:last-child, button[title="suivant"], button[title="Suivant"]');
      if (nextButton) {
        await nextButton.click();
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Go back
        const prevButton = await page.$('.fc-prev-button, .fc-left > .fc-button-group > button:first-child, button[title="précédent"], button[title="Précédent"]');
        if (prevButton) {
          await prevButton.click();
        }
      }

      calendarEvents = await eventPromise;
    }

    // Method 3: If still no events, scrape the DOM directly
    if (calendarEvents.length === 0) {
      console.log('[login] Method 2 failed, trying DOM scraping...');
      calendarEvents = await page.evaluate(() => {
        const events = [];
        const eventEls = document.querySelectorAll('.fc-event, .fc-day-grid-event, .fc-time-grid-event, [class*="event"]');
        eventEls.forEach((el, i) => {
          const titleEl = el.querySelector('.fc-title, .fc-list-item-title, .event-title');
          const timeEl = el.querySelector('.fc-time, .fc-list-item-time, .event-time');
          if (titleEl) {
            events.push({
              id: `dom-${i}`,
              title: titleEl.textContent.trim(),
              start: el.getAttribute('data-start') || timeEl?.textContent || '',
              end: el.getAttribute('data-end') || '',
              className: el.className || '',
            });
          }
        });
        return events;
      });
    }

    console.log(`[login] Found ${calendarEvents.length} events`);

    // Process events into our format
    const processedEvents = calendarEvents
      .filter(e => !e.is_empty && !e.is_break)
      .map(e => {
        const parsed = parseEventTitle(e.title);
        return {
          id: e.id || Math.random().toString(36).substr(2, 9),
          title: parsed.courseName,
          room: parsed.room,
          professor: parsed.professor,
          group: parsed.group,
          start: e.start,
          end: e.end,
          type: getEventType(e.className, e.title),
          rawTitle: parsed.raw,
          allDay: e.allDay || false,
        };
      });

    // Generate session token and store the browser session
    const token = generateToken();
    sessions.set(token, {
      browser,
      page,
      lastUsed: Date.now(),
      username,
    });

    // Save events to Supabase cache
    saveEvents(username, processedEvents).catch(e => {
      console.warn('[login] Failed to cache events:', e.message);
    });

    res.json({
      token,
      events: processedEvents,
      fromCache: false,
      message: `Connecté en tant que ${username}. ${processedEvents.length} événements trouvés.`,
    });

  } catch (error) {
    console.error('[login] Error:', error.message);
    if (browser) await browser.close().catch(() => { });
    res.status(500).json({
      error: `Erreur lors de la connexion: ${error.message}`,
    });
  }
});

/**
 * POST /api/navigate
 * Body: { token, direction: 'next' | 'prev' | 'today' }
 * Returns: { events: [...] }
 */
app.post('/api/navigate', async (req, res) => {
  const { token, direction } = req.body;

  const session = sessions.get(token);
  if (!session) {
    return res.status(401).json({ error: 'Session expirée. Veuillez vous reconnecter.' });
  }

  session.lastUsed = Date.now();
  const { page } = session;

  try {
    // Set up response interceptor
    const eventPromise = new Promise((resolve) => {
      const timeout = setTimeout(() => resolve([]), 15000);

      page.on('response', async (response) => {
        try {
          const contentType = response.headers()['content-type'] || '';
          if (contentType.includes('xml')) {
            const text = await response.text();
            if (text.includes('partial-response')) {
              const jsonResult = JSON.parse(convert.xml2json(text, { compact: true, spaces: 2 }));
              const updates = jsonResult['partial-response']?.['changes']?.['update'];
              if (updates) {
                const updateArray = Array.isArray(updates) ? updates : [updates];
                for (const update of updateArray) {
                  const cdata = update['_cdata'];
                  if (cdata) {
                    try {
                      const parsed = JSON.parse(cdata);
                      if (parsed.events) {
                        clearTimeout(timeout);
                        resolve(parsed.events);
                        return;
                      }
                    } catch (e) { /* not JSON */ }
                  }
                }
              }
            }
          }
        } catch (e) { /* ignore */ }
      });
    });

    // Click the appropriate navigation button
    let selector;
    if (direction === 'next') {
      selector = '.fc-next-button';
    } else if (direction === 'prev') {
      selector = '.fc-prev-button';
    } else {
      selector = '.fc-today-button';
    }

    const button = await page.$(selector);
    if (button) {
      await button.click();
    }

    const rawEvents = await eventPromise;

    const processedEvents = rawEvents
      .filter(e => !e.is_empty && !e.is_break)
      .map(e => {
        const parsed = parseEventTitle(e.title);
        return {
          id: e.id || Math.random().toString(36).substr(2, 9),
          title: parsed.courseName,
          room: parsed.room,
          professor: parsed.professor,
          group: parsed.group,
          start: e.start,
          end: e.end,
          type: getEventType(e.className, e.title),
          rawTitle: parsed.raw,
          allDay: e.allDay || false,
        };
      });

    res.json({ events: processedEvents });

  } catch (error) {
    console.error('[navigate] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/logout
 * Body: { token }
 */
app.post('/api/logout', async (req, res) => {
  const { token } = req.body;
  const session = sessions.get(token);
  if (session) {
    await session.browser.close().catch(() => { });
    sessions.delete(token);
  }
  res.json({ message: 'Déconnecté' });
});

/**
 * POST /api/cached-events
 * Body: { username }
 * Returns cached events from Supabase (no Aurion login needed)
 */
app.post('/api/cached-events', async (req, res) => {
  const { username } = req.body;
  if (!username) {
    return res.status(400).json({ error: 'Username requis' });
  }

  try {
    const cached = await getCachedEvents(username);
    if (cached && cached.events.length > 0) {
      console.log(`[cache] Returning ${cached.events.length} cached events for ${username}`);
      return res.json({
        events: cached.events,
        cachedAt: cached.lastUpdated,
        fresh: isCacheFresh(cached.lastUpdated, 2),
      });
    }
    res.json({ events: [], cachedAt: null, fresh: false });
  } catch (error) {
    console.error('[cache] Error:', error.message);
    res.json({ events: [], cachedAt: null, fresh: false });
  }
});

/**
 * GET /api/health
 */
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', activeSessions: sessions.size });
});

app.listen(PORT, () => {
  console.log(`\n🚀 Supmeca Planning Server running on http://localhost:${PORT}`);
  console.log(`📡 API endpoints:`);
  console.log(`   POST /api/login-and-fetch  - Login & fetch planning`);
  console.log(`   POST /api/cached-events    - Get cached events`);
  console.log(`   POST /api/navigate         - Navigate calendar`);
  console.log(`   POST /api/logout           - Logout`);
  console.log(`   GET  /api/health           - Health check\n`);
});

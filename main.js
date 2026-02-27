/* ============================================
   SUPMECA PLANNING — Main Application
   ============================================ */

const API_BASE = window.location.origin;

// --- State ---
const state = {
    token: null,
    username: '',
    events: [],
    currentDate: new Date(),
    selectedDay: new Date(),
    currentView: 'day', // 'day', 'week', 'list'
    theme: localStorage.getItem('theme') || 'dark',
};

// --- DOM Elements ---
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const loginView = $('#login-view');
const scheduleView = $('#schedule-view');
const loginForm = $('#login-form');
const loginBtn = $('#login-btn');
const loginError = $('#login-error');
const togglePw = $('#toggle-password');
const userBadge = $('#user-badge');
const periodLabel = $('#current-period');
const daySelector = $('#day-selector');
const weekView = $('#week-view');
const dayView = $('#day-view');
const listView = $('#list-view');
const calendarContainer = $('#calendar-container');
const loadingOverlay = $('#schedule-loading');
const emptyState = $('#empty-state');
const modal = $('#event-modal');

// --- Init ---
document.addEventListener('DOMContentLoaded', () => {
    applyTheme();
    setupEventListeners();

    // Try to restore cached data
    const cached = localStorage.getItem('supmeca_planning_cache');
    if (cached) {
        try {
            const data = JSON.parse(cached);
            if (data.events && data.events.length > 0) {
                state.events = data.events;
                state.username = data.username || '';
                // Don't auto-login, but show we have cached data
            }
        } catch (e) { /* ignore */ }
    }

    // Default to day view on mobile, week on desktop
    if (window.innerWidth < 768) {
        state.currentView = 'day';
    } else {
        state.currentView = 'week';
    }
    updateViewToggle();
});

// --- Event Listeners ---
function setupEventListeners() {
    loginForm.addEventListener('submit', handleLogin);

    togglePw.addEventListener('click', () => {
        const pw = $('#password');
        pw.type = pw.type === 'password' ? 'text' : 'password';
    });

    $('#btn-prev').addEventListener('click', () => navigateWeek(-1));
    $('#btn-next').addEventListener('click', () => navigateWeek(1));
    $('#btn-today').addEventListener('click', () => {
        state.currentDate = new Date();
        state.selectedDay = new Date();
        renderSchedule();
    });

    $('#btn-export').addEventListener('click', exportICS);
    $('#btn-refresh').addEventListener('click', refreshPlanning);
    $('#btn-theme').addEventListener('click', toggleTheme);
    $('#btn-logout').addEventListener('click', handleLogout);

    // View toggle
    $$('.view-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            state.currentView = btn.dataset.view;
            updateViewToggle();
            renderSchedule();
        });
    });

    // Modal
    $('#modal-close').addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
    });

    // Keyboard
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeModal();
        if (scheduleView.classList.contains('active')) {
            if (e.key === 'ArrowLeft') navigateWeek(-1);
            if (e.key === 'ArrowRight') navigateWeek(1);
        }
    });

    // Responsive: switch view on resize
    window.addEventListener('resize', () => {
        if (window.innerWidth < 768 && state.currentView === 'week') {
            state.currentView = 'day';
            updateViewToggle();
            renderSchedule();
        }
    });
}

// --- Login ---
async function handleLogin(e) {
    e.preventDefault();
    const username = $('#username').value.trim();
    const password = $('#password').value;

    if (!username || !password) return;

    // Show loading
    loginBtn.disabled = true;
    loginBtn.querySelector('.btn-text').hidden = true;
    loginBtn.querySelector('.btn-loader').hidden = false;
    loginError.hidden = true;

    try {
        // Step 1: Try to load cached events for instant display
        let showedCache = false;
        try {
            const cacheRes = await fetch(`${API_BASE}/api/cached-events`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username }),
            });
            const cacheData = await cacheRes.json();

            if (cacheData.events && cacheData.events.length > 0) {
                state.username = username;
                state.events = cacheData.events;
                showSchedule();
                showedCache = true;

                // If cache is fresh, we can skip the full login
                if (cacheData.fresh) {
                    console.log('[login] Cache is fresh, skipping Aurion scraping');
                    // Still do the login to get a token for navigation
                    fetch(`${API_BASE}/api/login-and-fetch`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ username, password }),
                    }).then(res => res.json()).then(data => {
                        if (data.token) state.token = data.token;
                        if (data.events && !data.fromCache) {
                            state.events = data.events;
                            renderSchedule();
                        }
                    }).catch(() => { });
                    return;
                }
            }
        } catch (e) {
            console.log('[login] No cache available, proceeding with login');
        }

        // Step 2: Full login & fetch from Aurion
        const res = await fetch(`${API_BASE}/api/login-and-fetch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password }),
        });

        const data = await res.json();

        if (!res.ok) {
            throw new Error(data.error || 'Erreur de connexion');
        }

        // Success
        state.token = data.token;
        state.username = username;
        state.events = data.events || [];

        // Cache the data locally too
        localStorage.setItem('supmeca_planning_cache', JSON.stringify({
            events: state.events,
            username: state.username,
            cachedAt: new Date().toISOString(),
        }));

        if (showedCache) {
            // Update the already-visible schedule with fresh data
            renderSchedule();
        } else {
            showSchedule();
        }
    } catch (error) {
        loginError.textContent = error.message;
        loginError.hidden = false;
        loginError.style.animation = 'none';
        requestAnimationFrame(() => { loginError.style.animation = ''; });
    } finally {
        loginBtn.disabled = false;
        loginBtn.querySelector('.btn-text').hidden = false;
        loginBtn.querySelector('.btn-loader').hidden = true;
    }
}

// --- Show Schedule View ---
function showSchedule() {
    loginView.classList.remove('active');
    scheduleView.classList.add('active');
    userBadge.textContent = state.username;
    renderSchedule();
    startNowIndicator();
}

// --- Navigate Weeks ---
function navigateWeek(direction) {
    if (state.currentView === 'day') {
        state.selectedDay = new Date(state.selectedDay);
        state.selectedDay.setDate(state.selectedDay.getDate() + direction);
        state.currentDate = new Date(state.selectedDay);
    } else {
        state.currentDate.setDate(state.currentDate.getDate() + direction * 7);
        state.selectedDay = new Date(state.currentDate);
    }
    renderSchedule();
}

// --- Render Schedule ---
function renderSchedule() {
    const view = state.currentView;

    weekView.hidden = view !== 'week';
    dayView.hidden = view !== 'day';
    listView.hidden = view !== 'list';
    daySelector.style.display = (view === 'day') ? 'flex' : 'none';

    updatePeriodLabel();

    if (view === 'week') renderWeekView();
    else if (view === 'day') renderDayView();
    else if (view === 'list') renderListView();

    // Show empty state if no visible events
    const visibleEvents = getEventsForCurrentView();
    emptyState.hidden = visibleEvents.length > 0;
    calendarContainer.style.display = visibleEvents.length > 0 ? '' : 'none';
}

function getEventsForCurrentView() {
    if (state.currentView === 'day') {
        return getEventsForDay(state.selectedDay);
    } else if (state.currentView === 'week') {
        const weekStart = getWeekStart(state.currentDate);
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekEnd.getDate() + 6);
        return state.events.filter(e => {
            const d = new Date(e.start);
            return d >= weekStart && d <= weekEnd;
        });
    } else {
        const weekStart = getWeekStart(state.currentDate);
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekEnd.getDate() + 6);
        return state.events.filter(e => {
            const d = new Date(e.start);
            return d >= weekStart && d <= weekEnd;
        });
    }
}

function updatePeriodLabel() {
    const opts = { month: 'long', year: 'numeric' };
    if (state.currentView === 'day') {
        const d = state.selectedDay;
        const dayName = d.toLocaleDateString('fr-FR', { weekday: 'long' });
        const dayNum = d.getDate();
        const month = d.toLocaleDateString('fr-FR', { month: 'long' });
        periodLabel.textContent = `${capitalize(dayName)} ${dayNum} ${capitalize(month)}`;
    } else {
        const weekStart = getWeekStart(state.currentDate);
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekEnd.getDate() + 5);
        const startStr = weekStart.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
        const endStr = weekEnd.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
        periodLabel.textContent = `${startStr} — ${endStr}`;
    }
}

function updateViewToggle() {
    $$('.view-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.view === state.currentView);
    });
}

// --- Week View ---
function renderWeekView() {
    const weekStart = getWeekStart(state.currentDate);
    const days = [];
    for (let i = 0; i < 6; i++) {
        const d = new Date(weekStart);
        d.setDate(d.getDate() + i);
        days.push(d);
    }

    weekView.innerHTML = '';
    weekView.style.setProperty('--day-count', days.length);

    // Time column
    const timeCol = document.createElement('div');
    timeCol.className = 'time-column';
    for (let h = 8; h <= 20; h++) {
        const label = document.createElement('div');
        label.className = 'time-label';
        label.textContent = `${h}:00`;
        timeCol.appendChild(label);
    }
    weekView.appendChild(timeCol);

    const today = new Date();

    // Day columns
    days.forEach(day => {
        const col = document.createElement('div');
        col.className = 'day-column';

        // Header
        const header = document.createElement('div');
        header.className = 'day-column-header';
        const dayNames = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
        header.innerHTML = `
      <span class="day-name">${dayNames[day.getDay()]}</span>
      <span class="day-num">${day.getDate()}</span>
    `;
        if (isSameDay(day, today)) header.classList.add('today');
        col.appendChild(header);

        // Hour grid lines
        const gridContainer = document.createElement('div');
        gridContainer.style.position = 'relative';
        for (let h = 8; h <= 20; h++) {
            const line = document.createElement('div');
            line.className = 'hour-line';
            gridContainer.appendChild(line);
        }

        // Events for this day
        const dayEvents = getEventsForDay(day);
        dayEvents.forEach((event, idx) => {
            const el = createWeekEvent(event, idx);
            if (el) gridContainer.appendChild(el);
        });

        col.appendChild(gridContainer);
        weekView.appendChild(col);
    });

    weekView.hidden = false;
}

function createWeekEvent(event, index) {
    const start = new Date(event.start);
    const end = new Date(event.end);
    if (isNaN(start.getTime())) return null;

    const startHour = start.getHours() + start.getMinutes() / 60;
    const endHour = end.getTime() ? (end.getHours() + end.getMinutes() / 60) : (startHour + 1);

    const hourHeight = 70; // matches CSS --hour-height
    const top = (startHour - 8) * hourHeight;
    const height = Math.max((endHour - startHour) * hourHeight, 25);

    if (top < 0) return null;

    const el = document.createElement('div');
    el.className = `cal-event type-${event.type}`;
    el.style.top = `${top}px`;
    el.style.height = `${height}px`;
    el.style.animationDelay = `${index * 50}ms`;

    const timeStr = `${formatTime(start)} - ${formatTime(end)}`;

    el.innerHTML = `
    <div class="event-title">${escapeHtml(event.title)}</div>
    ${event.room ? `<div class="event-room">📍 ${escapeHtml(event.room)}</div>` : ''}
    ${height > 50 && event.professor ? `<div class="event-prof">👤 ${escapeHtml(event.professor)}</div>` : ''}
    ${height > 65 ? `<div class="event-time-label">${timeStr}</div>` : ''}
  `;

    el.addEventListener('click', () => openModal(event));
    return el;
}

// --- Day View ---
function renderDayView() {
    renderDaySelector();

    const events = getEventsForDay(state.selectedDay);
    dayView.innerHTML = '';

    events
        .sort((a, b) => new Date(a.start) - new Date(b.start))
        .forEach((event, idx) => {
            const card = createDayEventCard(event, idx);
            dayView.appendChild(card);
        });

    dayView.hidden = false;
}

function renderDaySelector() {
    const weekStart = getWeekStart(state.currentDate);
    daySelector.innerHTML = '';
    const today = new Date();

    for (let i = 0; i < 7; i++) {
        const d = new Date(weekStart);
        d.setDate(d.getDate() + i);

        const dayNames = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
        const chip = document.createElement('div');
        chip.className = 'day-chip';

        if (isSameDay(d, state.selectedDay)) chip.classList.add('active');
        if (isSameDay(d, today)) chip.classList.add('today');
        if (getEventsForDay(d).length > 0) chip.classList.add('has-events');

        chip.innerHTML = `
      <span class="day-chip-name">${dayNames[d.getDay()]}</span>
      <span class="day-chip-num">${d.getDate()}</span>
      <span class="day-chip-dot"></span>
    `;

        chip.addEventListener('click', () => {
            state.selectedDay = new Date(d);
            renderSchedule();
        });

        daySelector.appendChild(chip);
    }
}

function createDayEventCard(event, index) {
    const start = new Date(event.start);
    const end = new Date(event.end);

    const card = document.createElement('div');
    card.className = `day-event-card type-${event.type}`;
    card.style.animationDelay = `${index * 80}ms`;

    const typeLabels = {
        cm: 'CM', td: 'TD', tp: 'TP', exam: 'Examen',
        projet: 'Projet', reunion: 'Réunion', cours: 'Cours'
    };

    card.innerHTML = `
    <div class="day-event-time">
      <span class="day-event-time-start">${formatTime(start)}</span>
      <span class="day-event-time-sep"></span>
      <span class="day-event-time-end">${formatTime(end)}</span>
    </div>
    <div class="day-event-info">
      <h3>${escapeHtml(event.title)}</h3>
      <div class="day-event-meta">
        ${event.room ? `
          <div class="day-event-meta-item">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
              <circle cx="12" cy="10" r="3"/>
            </svg>
            <span>${escapeHtml(event.room)}</span>
          </div>
        ` : ''}
        ${event.professor ? `
          <div class="day-event-meta-item">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
              <circle cx="12" cy="7" r="4"/>
            </svg>
            <span>${escapeHtml(event.professor)}</span>
          </div>
        ` : ''}
      </div>
    </div>
    <span class="day-event-type-badge">${typeLabels[event.type] || 'Cours'}</span>
  `;

    card.addEventListener('click', () => openModal(event));
    return card;
}

// --- List View ---
function renderListView() {
    const weekStart = getWeekStart(state.currentDate);
    listView.innerHTML = '';

    const dayNames = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];

    for (let i = 0; i < 6; i++) {
        const d = new Date(weekStart);
        d.setDate(d.getDate() + i);
        const events = getEventsForDay(d);
        if (events.length === 0) continue;

        const group = document.createElement('div');
        group.className = 'list-day-group';

        const header = document.createElement('div');
        header.className = 'list-day-header';
        header.textContent = `${dayNames[d.getDay()]} ${d.getDate()} ${d.toLocaleDateString('fr-FR', { month: 'long' })}`;
        group.appendChild(header);

        events
            .sort((a, b) => new Date(a.start) - new Date(b.start))
            .forEach(event => {
                const start = new Date(event.start);
                const end = new Date(event.end);

                const item = document.createElement('div');
                item.className = `list-event type-${event.type}`;
                item.innerHTML = `
          <div class="list-event-color"></div>
          <div class="list-event-time">${formatTime(start)} - ${formatTime(end)}</div>
          <div class="list-event-title">${escapeHtml(event.title)}</div>
          <div class="list-event-room">${event.room ? '📍 ' + escapeHtml(event.room) : ''}</div>
        `;
                item.addEventListener('click', () => openModal(event));
                group.appendChild(item);
            });

        listView.appendChild(group);
    }

    listView.hidden = false;
}

// --- Modal ---
function openModal(event) {
    const start = new Date(event.start);
    const end = new Date(event.end);

    const typeLabels = {
        cm: 'CM', td: 'TD', tp: 'TP', exam: 'Examen',
        projet: 'Projet', reunion: 'Réunion', cours: 'Cours'
    };

    const typeColors = {
        cm: 'var(--color-cm)', td: 'var(--color-td)', tp: 'var(--color-tp)',
        exam: 'var(--color-exam)', projet: 'var(--color-projet)',
        reunion: 'var(--color-reunion)', cours: 'var(--color-cours)',
    };

    const badge = $('#modal-type-badge');
    badge.textContent = typeLabels[event.type] || 'Cours';
    badge.style.background = `${typeColors[event.type]}20`;
    badge.style.color = typeColors[event.type];

    $('#modal-title').textContent = event.title;

    const dayName = start.toLocaleDateString('fr-FR', { weekday: 'long' });
    const dateStr = start.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
    $('#modal-time').textContent = `${capitalize(dayName)} ${dateStr}, ${formatTime(start)} — ${formatTime(end)}`;

    const roomRow = $('#modal-room-row');
    if (event.room) {
        $('#modal-room').textContent = event.room;
        roomRow.hidden = false;
    } else {
        roomRow.hidden = true;
    }

    const profRow = $('#modal-prof-row');
    if (event.professor) {
        $('#modal-prof').textContent = event.professor;
        profRow.hidden = false;
    } else {
        profRow.hidden = true;
    }

    const groupRow = $('#modal-group-row');
    if (event.group) {
        $('#modal-group').textContent = event.group;
        groupRow.hidden = false;
    } else {
        groupRow.hidden = true;
    }

    modal.hidden = false;
}

function closeModal() {
    modal.hidden = true;
}

// --- Now Indicator ---
function startNowIndicator() {
    const updateNow = () => {
        const now = new Date();
        const hour = now.getHours() + now.getMinutes() / 60;
        const indicator = $('#now-indicator');

        if (hour >= 8 && hour <= 20 && state.currentView === 'week') {
            const hourHeight = 70;
            const top = (hour - 8) * hourHeight;
            indicator.style.top = `${top + 48}px`; // offset for header
            indicator.hidden = false;
        } else {
            indicator.hidden = true;
        }
    };

    updateNow();
    setInterval(updateNow, 60000);
}

// --- Theme ---
function applyTheme() {
    document.documentElement.setAttribute('data-theme', state.theme);
}

function toggleTheme() {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('theme', state.theme);
    applyTheme();
}

// --- Export ICS ---
function exportICS() {
    if (state.events.length === 0) return;

    let ics = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Supmeca Planning//FR',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        'X-WR-CALNAME:Supmeca Planning',
        'X-WR-TIMEZONE:Europe/Paris',
    ];

    state.events.forEach(event => {
        const start = new Date(event.start);
        const end = new Date(event.end);
        if (isNaN(start.getTime())) return;

        const dtStart = formatICSDate(start);
        const dtEnd = formatICSDate(end.getTime() ? end : new Date(start.getTime() + 3600000));

        ics.push('BEGIN:VEVENT');
        ics.push(`DTSTART;TZID=Europe/Paris:${dtStart}`);
        ics.push(`DTEND;TZID=Europe/Paris:${dtEnd}`);
        ics.push(`SUMMARY:${escapeICS(event.title)}`);
        if (event.room) ics.push(`LOCATION:${escapeICS(event.room)}`);
        const desc = [event.professor, event.group, event.rawTitle].filter(Boolean).join(' | ');
        if (desc) ics.push(`DESCRIPTION:${escapeICS(desc)}`);
        ics.push(`UID:${event.id}@supmeca-planning`);
        ics.push('END:VEVENT');
    });

    ics.push('END:VCALENDAR');

    const blob = new Blob([ics.join('\r\n')], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `supmeca-planning-${formatDateForFile(new Date())}.ics`;
    a.click();
    URL.revokeObjectURL(url);
}

// --- Refresh ---
async function refreshPlanning() {
    if (!state.token) {
        // No active session, go back to login
        scheduleView.classList.remove('active');
        loginView.classList.add('active');
        return;
    }

    loadingOverlay.hidden = false;
    try {
        const res = await fetch(`${API_BASE}/api/navigate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: state.token, direction: 'today' }),
        });
        const data = await res.json();
        if (data.events && data.events.length > 0) {
            state.events = data.events;
            localStorage.setItem('supmeca_planning_cache', JSON.stringify({
                events: state.events,
                username: state.username,
                cachedAt: new Date().toISOString(),
            }));
        }
        renderSchedule();
    } catch (error) {
        console.error('Refresh failed:', error);
    } finally {
        loadingOverlay.hidden = true;
    }
}

// --- Logout ---
async function handleLogout() {
    if (state.token) {
        fetch(`${API_BASE}/api/logout`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: state.token }),
        }).catch(() => { });
    }

    state.token = null;
    state.events = [];
    state.username = '';
    scheduleView.classList.remove('active');
    loginView.classList.add('active');
    $('#password').value = '';
}

// --- Utility Functions ---
function getWeekStart(date) {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday
    d.setDate(diff);
    d.setHours(0, 0, 0, 0);
    return d;
}

function getEventsForDay(date) {
    return state.events.filter(e => {
        const eventDate = new Date(e.start);
        return isSameDay(eventDate, date);
    });
}

function isSameDay(a, b) {
    return a.getFullYear() === b.getFullYear() &&
        a.getMonth() === b.getMonth() &&
        a.getDate() === b.getDate();
}

function formatTime(date) {
    if (!(date instanceof Date) || isNaN(date.getTime())) return '--:--';
    return date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

function formatICSDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const h = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    return `${y}${m}${d}T${h}${min}00`;
}

function formatDateForFile(date) {
    return date.toISOString().split('T')[0];
}

function capitalize(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function escapeICS(str) {
    if (!str) return '';
    return str.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

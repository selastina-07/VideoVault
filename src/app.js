import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const PLAN_LIMITS = {
  free: 1,
  bronze: 3,
  silver: 5,
  gold: 10,
};

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function makeId(prefix = 'id') {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function getStartOfDay(date = new Date()) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  return start;
}

function getIsoDateTime(date = new Date()) {
  return new Date(date).toISOString();
}

function buildProfileHtml(user, subscription, quota, downloads, csrfToken) {
  const rows = downloads.length
    ? downloads
        .map(
          (download) => `
            <tr>
              <td>
                <div class="video-cell">
                  <img src="${download.thumbnail_url}" alt="${download.title}" />
                  <div>
                    <strong>${download.title}</strong>
                    <small>${download.video_id}</small>
                  </div>
                </div>
              </td>
              <td>${new Date(download.downloaded_at).toLocaleString()}</td>
              <td><span class="badge ${download.status}">${download.status}</span></td>
              <td>${formatBytes(download.file_size_bytes)}</td>
              <td>${download.plan_name}</td>
              <td>${quota.remaining}/${quota.limit}</td>
            </tr>
          `,
        )
        .join('')
    : `
      <tr>
        <td colspan="6" class="empty-state">No videos downloaded yet.</td>
      </tr>
    `;

  return `<!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Downloads &amp; Profile | VideoVault</title>
        <style>
          :root {
            --bg: #071325;
            --panel: #101c2f;
            --panel-alt: #16253f;
            --accent: #38bdf8;
            --accent-2: #10b981;
            --danger: #f87171;
            --text: #ebf3ff;
            --muted: #a8bfdc;
            --border: rgba(148, 163, 184, 0.2);
          }
          * { box-sizing: border-box; }
          body {
            margin: 0; font-family: Arial, sans-serif; background: linear-gradient(180deg, #020c19, var(--bg));
            color: var(--text); min-height: 100vh;
          }
          .page { max-width: 1200px; margin: 32px auto; padding: 0 16px 50px; }
          .topbar {
            display: flex; justify-content: space-between; align-items: center; padding: 18px 0 28px;
          }
          .brand { font-size: 24px; font-weight: bold; letter-spacing: -0.04em; }
          .brand span { color: var(--accent); }
          .nav { display: flex; gap: 10px; }
          .button {
            text-decoration: none; color: var(--text); background: var(--panel-alt); border: 1px solid var(--border);
            border-radius: 999px; padding: 10px 18px; cursor: pointer; display: inline-block;
          }
          .button.primary { background: var(--accent); border-color: var(--accent); color: #042033; }
          .button.warn { background: #1f2937; }
          .profile-card, .downloads-card {
            background: rgba(16, 28, 47, 0.95); border: 1px solid var(--border); border-radius: 18px; padding: 24px; box-shadow: 0 10px 35px rgba(2, 6, 23, 0.4);
          }
          .profile-card { display: grid; grid-template-columns: 1.2fr 1fr; gap: 16px; margin-bottom: 22px; }
          .stat-row { display: grid; grid-template-columns: repeat(3, minmax(100px, 1fr)); gap: 12px; }
          .stat {
            background: rgba(28, 41, 59, 0.9); border: 1px solid var(--border); border-radius: 12px; padding: 14px;
          }
          .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }
          .value { font-size: 24px; font-weight: 700; margin-top: 8px; }
          .badge {
            display: inline-flex; padding: 6px 10px; border-radius: 999px; font-size: 12px; font-weight: 700; text-transform: uppercase;
          }
          .badge.completed { background: rgba(16, 185, 129, 0.15); color: #86efac; }
          .badge.failed { background: rgba(239, 68, 68, 0.15); color: #fca5a5; }
          .badge.in_progress { background: rgba(59, 130, 246, 0.15); color: #93c5fd; }
          .badge.duplicate { background: rgba(245, 158, 11, 0.15); color: #fcd34d; }
          table { width: 100%; border-collapse: collapse; margin-top: 14px; }
          th, td { padding: 14px 10px; text-align: left; border-bottom: 1px solid var(--border); vertical-align: middle; }
          th { color: var(--muted); text-transform: uppercase; font-size: 12px; }
          img { width: 90px; height: 56px; object-fit: cover; border-radius: 10px; border: 1px solid rgba(148,163,184,0.3); }
          .video-cell { display: flex; align-items: center; gap: 12px; }
          .empty-state { padding: 24px 12px; color: var(--muted); text-align: center; }
          @media (max-width: 760px) {
            .profile-card { grid-template-columns: 1fr; }
            .topbar { align-items: flex-start; flex-wrap: wrap; gap: 14px; }
            .nav { flex-wrap: wrap; }
            table { display:block; overflow-x:auto; }
          }
        </style>
      </head>
      <body>
        <div class="page">
          <header class="topbar">
            <div class="brand">Video<span>Vault</span></div>
            <div class="nav">
              <a href="/videos" class="button">Videos</a>
              <a href="/profile" class="button primary">Downloads</a>
              <form action="/logout" method="post" style="margin:0">
                <input type="hidden" name="csrfToken" value="${csrfToken}" />
                <button class="button warn" type="submit">Log out</button>
              </form>
            </div>
          </header>

          <section class="profile-card">
            <div>
              <div class="label">Your VideoVault account</div>
              <h1>Your download library</h1>
              <p style="color: var(--muted);">Your VideoVault history, ready when you are.</p>
              <p style="color: var(--muted); margin-top: 0;">Active plan: <strong>${subscription.plan_name}</strong></p>
              <div class="stat-row">
                <div class="stat">
                  <div class="label">Status</div>
                  <div class="value">${subscription.status}</div>
                </div>
                <div class="stat">
                  <div class="label">Remaining</div>
                  <div class="value">${quota.remaining}</div>
                </div>
                <div class="stat">
                  <div class="label">Daily limit</div>
                  <div class="value">${quota.limit}</div>
                </div>
              </div>
            </div>
            <div>
              <div class="stat">
                <div class="label">Subscription</div>
                <div class="value">${subscription.plan_name}</div>
              </div>
              <div class="stat" style="margin-top:12px;">
                <div class="label">Renewal</div>
                <div class="value">${new Date(subscription.expires_at || subscription.starts_at).toLocaleDateString()}</div>
              </div>
            </div>
          </section>

          <section class="downloads-card">
            <h2>Downloads</h2>
            <table>
              <thead>
                <tr>
                  <th>Video</th>
                  <th>Downloaded At</th>
                  <th>Status</th>
                  <th>File Size</th>
                  <th>Plan</th>
                  <th>Quota Left</th>
                </tr>
              </thead>
              <tbody>
                ${rows}
              </tbody>
            </table>
          </section>
        </div>
      </body>
    </html>`;
}

function ensureDemoData(database, videoDirectory) {
  const now = Date.now();
  const users = [
    { id: 'user_free', email: 'free@streamnest.test', password: 'password123', plan: 'free', deviceId: 'device-free', browser: 'Chrome' },
    { id: 'user_bronze', email: 'bronze@streamnest.test', password: 'password123', plan: 'bronze', deviceId: 'device-bronze', browser: 'Chrome' },
    { id: 'user_silver', email: 'silver@streamnest.test', password: 'password123', plan: 'silver', deviceId: 'device-silver', browser: 'Safari' },
    { id: 'user_gold', email: 'gold@streamnest.test', password: 'password123', plan: 'gold', deviceId: 'device-gold', browser: 'Firefox' },
  ];

  const insertUser = database.prepare(
    'INSERT OR IGNORE INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)',
  );

  for (const user of users) {
    insertUser.run(user.id, user.email, sha256(user.password), getIsoDateTime(now));

    const existingSubscription = database
      .prepare('SELECT id FROM subscriptions WHERE user_id = ? AND status = ?')
      .get(user.id, 'active');
    if (!existingSubscription) {
      const subId = `sub_${user.id}`;
      database.prepare(
        'INSERT OR IGNORE INTO subscriptions (id, user_id, plan_id, status, starts_at, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(
        subId,
        user.id,
        user.plan,
        'active',
        getIsoDateTime(now - 86400000),
        getIsoDateTime(now + 7 * 24 * 60 * 60 * 1000),
        getIsoDateTime(now),
      );
    }

    database.prepare(
      'INSERT OR IGNORE INTO user_devices (id, user_id, device_id, device_name, browser, is_registered, last_seen, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      `device_${user.id}`,
      user.id,
      user.deviceId,
      `${user.plan.toUpperCase()} Device`,
      user.browser,
      1,
      getIsoDateTime(now),
      getIsoDateTime(now),
    );
  }

  const videos = [
    { id: 'vid_alpha', title: 'Alpha Summit', thumbnail_url: 'https://images.unsplash.com/photo-1526379095098-d400fd0bf935?auto=format&fit=crop&w=800&q=80', media_path: 'alpha-summit.mp4', mime_type: 'video/mp4' },
    { id: 'vid_beta', title: 'Mountain Drift', thumbnail_url: 'https://images.unsplash.com/photo-1493246507139-91e8fad9978e?auto=format&fit=crop&w=800&q=80', media_path: 'mountain-drift.mp4', mime_type: 'video/mp4' },
    { id: 'vid_gamma', title: 'City Pulse', thumbnail_url: 'https://images.unsplash.com/photo-1516321165247-4aa89a48be28?auto=format&fit=crop&w=800&q=80', media_path: 'city-pulse.mp4', mime_type: 'video/mp4' },
    { id: 'vid_delta', title: 'Night Ride', thumbnail_url: 'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=800&q=80', media_path: 'night-ride.mp4', mime_type: 'video/mp4' },
  ];

  const insertVideo = database.prepare(
    'INSERT OR IGNORE INTO videos (id, title, thumbnail_url, media_path, mime_type, file_size_bytes, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const updateVideoSize = database.prepare(
    'UPDATE videos SET file_size_bytes = ? WHERE id = ?',
  );

  for (const video of videos) {
    const filePath = path.join(videoDirectory, video.media_path);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const fileSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
    insertVideo.run(
      video.id,
      video.title,
      video.thumbnail_url,
      video.media_path,
      video.mime_type,
      fileSize,
      1,
      getIsoDateTime(now),
    );
    updateVideoSize.run(fileSize, video.id);
  }
}

export function createApp(database, options = {}) {
  const app = express();
  const videoDirectory = path.resolve(options.videoDirectory || path.join(__dirname, '..', 'storage', 'videos'));
  const duplicateWindowMs = options.duplicateWindowMs || 24 * 60 * 60 * 1000;
  const sessionTtlMs = options.sessionTtlMs || 7 * 24 * 60 * 60 * 1000;
  const reservationTtlMs = options.reservationTtlMs || 30 * 60 * 1000;
  const requireRegisteredDevice = options.requireRegisteredDevice ?? true;
  const activeTransfers = new Set();

  ensureDemoData(database, videoDirectory);

  app.use(cookieParser());
  app.use(express.static(PUBLIC_DIR));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  function requestMetadata(req) {
    return {
      ipAddress: req.ip || req.socket?.remoteAddress || 'unknown',
      deviceInformation: String(req.body?.deviceId || req.headers['x-device-id'] || 'unknown'),
      browser: String(req.headers['user-agent'] || 'unknown'),
    };
  }

  function auditAttempt(req, outcome, details = {}, downloadId = null) {
    const metadata = requestMetadata(req);
    const requestedVideoId = req.params?.videoId;
    const videoId = requestedVideoId
      ? database.prepare('SELECT id FROM videos WHERE id = ?').get(requestedVideoId)?.id || null
      : null;
    const validDownloadId = downloadId
      ? database.prepare('SELECT id FROM download_records WHERE id = ?').get(downloadId)?.id || null
      : null;
    database.prepare(
      `INSERT INTO download_attempts
       (id, user_id, video_id, download_id, attempted_at, outcome, ip_address, device_information, browser, details)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      makeId('attempt'),
      req.sessionUser?.id || null,
      videoId,
      validDownloadId,
      getIsoDateTime(Date.now()),
      outcome,
      metadata.ipAddress,
      metadata.deviceInformation,
      metadata.browser,
      JSON.stringify(details),
    );
  }

  function appendHistory(downloadId, eventType, details) {
    database.prepare(
      'INSERT INTO download_history (id, download_id, event_type, event_at, details) VALUES (?, ?, ?, ?, ?)',
    ).run(makeId('hist'), downloadId, eventType, getIsoDateTime(Date.now()), details);
  }

  function sameToken(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) {
      return false;
    }
    return crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right));
  }

  function submittedCsrfToken(req) {
    return req.get('x-csrf-token') || req.body?.csrfToken;
  }

  function setSessionCookie(res, userId) {
    const sessionToken = crypto.randomBytes(24).toString('hex');
    const expiresAt = Date.now() + sessionTtlMs;
    const csrfToken = crypto.randomBytes(16).toString('hex');
    database.prepare(
      'INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(token_hash) DO UPDATE SET user_id = excluded.user_id, csrf_token = excluded.csrf_token, expires_at = excluded.expires_at',
    ).run(sha256(sessionToken), userId, csrfToken, expiresAt);

    res.cookie('stream_session', sessionToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: options.secureCookies ?? false,
      maxAge: sessionTtlMs,
    });
    res.cookie('stream_csrf', csrfToken, {
      httpOnly: false,
      sameSite: 'strict',
      secure: options.secureCookies ?? false,
      maxAge: sessionTtlMs,
    });
    return { sessionToken, csrfToken };
  }

  function clearSessionCookie(res) {
    res.clearCookie('stream_session');
  }

  function getCurrentSession(req) {
    const token = req.cookies?.stream_session || req.headers['x-session-token'];
    if (!token) return null;
    const tokenHash = sha256(token);
    const session = database.prepare(
      'SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?',
    ).get(tokenHash, Date.now());
    if (!session) return null;
    const user = database.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id);
    if (!user) return null;
    return { user, session };
  }

  function getActiveSubscription(userId) {
    const subscription = database
      .prepare(
        `SELECT s.*, p.name AS plan_name, p.daily_limit
         FROM subscriptions s
         JOIN plans p ON p.id = s.plan_id
        WHERE s.user_id = ? AND s.status = 'active' AND s.starts_at <= ?
          AND (s.expires_at IS NULL OR s.expires_at > ?)
        ORDER BY s.starts_at DESC LIMIT 1`,
      )
      .get(userId, getIsoDateTime(Date.now()), getIsoDateTime(Date.now()));

    return subscription || null;
  }

  function getRemainingQuota(userId, subscription) {
    expireStaleReservations(userId);
    const dailyLimit = subscription?.daily_limit || PLAN_LIMITS.free;
    const start = getStartOfDay(new Date()).toISOString();
    const end = new Date(getStartOfDay(new Date()).getTime() + 24 * 60 * 60 * 1000).toISOString();

    const result = database
      .prepare(
        `SELECT COUNT(*) AS used
         FROM download_records
         WHERE user_id = ?
           AND plan_id = ?
           AND status IN ('completed', 'in_progress')
           AND downloaded_at >= ?
           AND downloaded_at < ?`,
      )
      .get(userId, subscription?.plan_id || 'free', start, end);

    const used = Number(result?.used || 0);
    return {
      limit: dailyLimit,
      used,
      remaining: Math.max(0, dailyLimit - used),
    };
  }

  function getRecentDuplicateDownload(userId, videoId) {
    const duplicateWindowStart = new Date(Date.now() - duplicateWindowMs).toISOString();
    return database
      .prepare(
        `SELECT *
         FROM download_records
         WHERE user_id = ? AND video_id = ?
           AND downloaded_at >= ?
           AND status IN ('completed', 'in_progress')
         ORDER BY downloaded_at DESC LIMIT 1`,
      )
      .get(userId, videoId, duplicateWindowStart);
  }

  function expireStaleReservations(userId = null) {
    const cutoff = getIsoDateTime(Date.now() - reservationTtlMs);
    const sql = userId
      ? `SELECT id, user_id, video_id, ip_address, device_information, browser FROM download_records
         WHERE user_id = ? AND status = 'in_progress'
           AND COALESCE(transfer_heartbeat_at, transfer_started_at, downloaded_at) < ?`
      : `SELECT id, user_id, video_id, ip_address, device_information, browser FROM download_records
         WHERE status = 'in_progress'
           AND COALESCE(transfer_heartbeat_at, transfer_started_at, downloaded_at) < ?`;
    const stale = userId
      ? database.prepare(sql).all(userId, cutoff)
      : database.prepare(sql).all(cutoff);

    for (const record of stale) {
      if (activeTransfers.has(record.id)) continue;
      const result = database.prepare(
        `UPDATE download_records
         SET status = 'failed', failure_reason = 'Download reservation expired.'
         WHERE id = ? AND status = 'in_progress'`,
      ).run(record.id);
      if (result.changes) {
        appendHistory(record.id, 'reservation_expired', 'Abandoned reservation expired and quota was released.');
        database.prepare(
          `INSERT INTO download_attempts
           (id, user_id, video_id, download_id, attempted_at, outcome, ip_address, device_information, browser, details)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          makeId('attempt'),
          record.user_id,
          record.video_id,
          record.id,
          getIsoDateTime(Date.now()),
          'reservation_expired',
          record.ip_address,
          record.device_information,
          record.browser,
          JSON.stringify({ reason: 'Abandoned reservation expired.' }),
        );
      }
    }
  }

  expireStaleReservations();

  function validateDeviceRegistration(userId, providedDeviceId) {
    if (!requireRegisteredDevice) return true;
    if (!providedDeviceId) return false;
    const device = database
      .prepare('SELECT * FROM user_devices WHERE user_id = ? AND device_id = ? AND is_registered = 1')
      .get(userId, providedDeviceId);
    return Boolean(device);
  }

  function requireAuth(req, res, next) {
    const session = getCurrentSession(req);
    if (!session) {
      if (req.path.startsWith('/api/')) {
        auditAttempt(req, 'unauthorized', { reason: 'Authentication required.' });
        return res.status(401).json({ ok: false, error: 'Authentication required.' });
      }
      return res.redirect('/login');
    }
    req.sessionUser = session.user;
    req.session = session.session;
    res.cookie('stream_csrf', session.session.csrf_token, {
      httpOnly: false,
      sameSite: 'strict',
      secure: options.secureCookies ?? false,
      maxAge: sessionTtlMs,
    });
    next();
  }

  app.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

    const submitted = submittedCsrfToken(req);
    if (req.path === '/login' && req.method === 'POST') {
      if (!sameToken(submitted, req.cookies?.stream_csrf)) {
        return res.status(403).json({ ok: false, error: 'CSRF validation failed.' });
      }
      return next();
    }

    const currentSession = getCurrentSession(req);
    if (currentSession) {
      req.sessionUser = currentSession.user;
      req.session = currentSession.session;
    }
    if (
      !currentSession
      || !sameToken(submitted, currentSession.session.csrf_token)
      || !sameToken(req.cookies?.stream_csrf, currentSession.session.csrf_token)
    ) {
      auditAttempt(req, 'csrf_rejected', { reason: 'Missing or invalid CSRF token.' });
      return res.status(403).json({ ok: false, error: 'CSRF validation failed.' });
    }
    next();
  });

  app.get('/', (req, res) => {
    const session = getCurrentSession(req);
    if (!session) return res.redirect('/login');
    return res.redirect('/profile');
  });

  app.get('/login', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
  });

  app.get('/api/csrf', (req, res) => {
    const session = getCurrentSession(req);
    if (session) {
      res.cookie('stream_csrf', session.session.csrf_token, {
        httpOnly: false,
        sameSite: 'strict',
        secure: options.secureCookies ?? false,
        maxAge: sessionTtlMs,
      });
      return res.json({ csrfToken: session.session.csrf_token });
    }

    const csrfToken = crypto.randomBytes(16).toString('hex');
    res.cookie('stream_csrf', csrfToken, {
      httpOnly: false,
      sameSite: 'strict',
      secure: options.secureCookies ?? false,
      maxAge: 10 * 60 * 1000,
    });
    return res.json({ csrfToken });
  });

  app.post('/login', (req, res) => {
    const submittedEmail = String(req.body?.email || '').trim();
    const email = submittedEmail.replace(/@(videovault)\.test$/i, '@streamnest.test');
    const password = String(req.body?.password || '');
    const user = database
      .prepare('SELECT * FROM users WHERE email = ? AND password_hash = ?')
      .get(email, sha256(password));

    if (!user) {
      return res.status(401).json({ ok: false, error: 'Invalid email or password.' });
    }

    const session = setSessionCookie(res, user.id);
    return res.json({ ok: true, redirect: '/profile', csrfToken: session.csrfToken });
  });

  app.post('/logout', requireAuth, (req, res) => {
    const token = req.cookies?.stream_session;
    if (token) {
      const tokenHash = sha256(token);
      database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    }
    clearSessionCookie(res);
    res.clearCookie('stream_csrf');
    res.redirect('/login');
  });

  app.get('/videos', requireAuth, (req, res) => {
    const videos = database.prepare('SELECT * FROM videos WHERE is_active = 1 ORDER BY created_at DESC').all();
    const user = req.sessionUser;
    const subscription = getActiveSubscription(user.id);
    const quota = getRemainingQuota(user.id, subscription);

    const items = videos
      .map(
        (video) => `
          <div class="video-panel">
            <img src="${video.thumbnail_url}" alt="${video.title}" />
            <div class="video-info">
              <h3>${video.title}</h3>
              <p>${formatBytes(video.file_size_bytes)}</p>
              <form class="download-form" action="/api/v1/downloads/${video.id}" method="post">
                <input type="hidden" name="deviceId" value="${database.prepare('SELECT device_id FROM user_devices WHERE user_id = ? LIMIT 1').get(user.id)?.device_id || 'device-default'}" />
                <input type="hidden" name="csrfToken" value="${req.session.csrf_token}" />
                <button class="download-button" type="submit">Download</button>
                <span class="download-status" aria-live="polite"></span>
              </form>
            </div>
          </div>
        `,
      )
      .join('');

    res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Video Library | VideoVault</title><style>
      :root{color-scheme:dark;--bg:#071325;--panel:#101c2f;--panel-alt:#16253f;--accent:#38bdf8;--text:#ebf3ff;--muted:#a8bfdc;--border:rgba(148,163,184,.2)}
      *{box-sizing:border-box}body{margin:0;font-family:Arial,sans-serif;background:linear-gradient(180deg,#020c19,var(--bg));color:var(--text);min-height:100vh}
      .container{max-width:1120px;margin:0 auto;padding:24px 20px 56px}.topbar{display:flex;align-items:center;justify-content:space-between;padding:8px 0 30px}
      .brand{font-size:24px;font-weight:800;letter-spacing:-.04em}.brand span{color:var(--accent)}.nav{display:flex;align-items:center;gap:10px}
      .button{display:inline-block;text-decoration:none;color:var(--text);background:var(--panel-alt);border:1px solid var(--border);border-radius:999px;padding:10px 16px;cursor:pointer;font:inherit}
      .button.active,.button.primary{background:#0c4a6e;border-color:#0ea5e9}.button.warn{background:#1f2937}
      .hero{display:flex;align-items:end;justify-content:space-between;gap:20px;margin-bottom:22px}.eyebrow{color:var(--accent);font-size:12px;font-weight:700;letter-spacing:.13em;text-transform:uppercase}
      h1{font-size:clamp(30px,5vw,44px);margin:8px 0}.hero p,.quota{color:var(--muted);margin:0}.quota{padding:12px 16px;border:1px solid var(--border);background:var(--panel);border-radius:12px;white-space:nowrap}
      .video-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));gap:16px}.video-panel{overflow:hidden;border:1px solid var(--border);border-radius:16px;background:var(--panel);box-shadow:0 12px 30px rgba(2,6,23,.24)}
      .video-panel img{width:100%;height:190px;object-fit:cover;display:block}.video-info{padding:16px}.video-info h3{font-size:18px;margin:0 0 6px}.video-info p{color:var(--muted);font-size:14px;margin:0 0 16px}
      .download-form{display:flex;align-items:center;gap:10px}.download-button{background:var(--accent);color:#042033;padding:10px 16px;border:0;border-radius:10px;font-weight:700;cursor:pointer}.download-button:disabled{opacity:.65;cursor:wait}
      .download-status{color:#fca5a5;font-size:13px}.empty{padding:28px;border:1px dashed var(--border);border-radius:14px;color:var(--muted);text-align:center}
      @media(max-width:600px){.container{padding:16px 14px 36px}.topbar{padding-bottom:24px}.nav{gap:6px}.button{padding:9px 12px;font-size:14px}.hero{align-items:flex-start;flex-direction:column}.quota{white-space:normal}.video-panel img{height:175px}}
      </style></head><body><main class="container"><header class="topbar"><div class="brand">Video<span>Vault</span></div><nav class="nav" aria-label="Main navigation"><a href="/videos" class="button active" aria-current="page">Videos</a><a href="/profile" class="button">Downloads</a><form action="/logout" method="post" style="margin:0"><input type="hidden" name="csrfToken" value="${req.session.csrf_token}"><button class="button warn" type="submit">Log out</button></form></nav></header><section class="hero"><div><div class="eyebrow">Your personal video library</div><h1>Find your next download</h1><p>Save videos securely, with clear plan limits and download history.</p></div><p class="quota"><strong>${subscription?.plan_name || 'Free'}</strong> plan &nbsp;·&nbsp; ${quota.remaining} of ${quota.limit} downloads remaining today</p></section><section class="video-grid" aria-label="Available videos">${items || '<p class="empty">No videos are available right now.</p>'}</section></main><script>
      document.querySelectorAll('.download-form').forEach((form) => {
        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          const button = form.querySelector('button');
          const status = form.querySelector('.download-status');
          button.disabled = true;
          status.textContent = 'Preparing download…';
          try {
            const values = Object.fromEntries(new FormData(form).entries());
            const response = await fetch(form.action, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': values.csrfToken },
              body: JSON.stringify(values),
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'Download could not be authorized.');
            const transferForm = document.createElement('form');
            transferForm.method = 'POST';
            transferForm.action = result.fileUrl;
            const csrfInput = document.createElement('input');
            csrfInput.type = 'hidden';
            csrfInput.name = 'csrfToken';
            csrfInput.value = values.csrfToken;
            transferForm.appendChild(csrfInput);
            document.body.appendChild(transferForm);
            transferForm.submit();
            transferForm.remove();
            status.textContent = 'Download started. Check your browser downloads.';
          } catch (error) {
            status.textContent = error.message || 'Download failed.';
            button.disabled = false;
          }
        });
      });
    </script></body></html>`);
  });

  app.get('/profile', requireAuth, (req, res) => {
    const user = req.sessionUser;
    const subscription = getActiveSubscription(user.id);
    const quota = getRemainingQuota(user.id, subscription);

    const downloads = database
      .prepare(
        `SELECT dr.*, v.title, v.thumbnail_url, p.name AS plan_name
         FROM download_records dr
         JOIN videos v ON v.id = dr.video_id
         JOIN plans p ON p.id = dr.plan_id
         WHERE dr.user_id = ?
         ORDER BY dr.downloaded_at DESC`,
      )
      .all(user.id);

    res.send(buildProfileHtml(user, {
      plan_name: subscription?.plan_name || 'Free',
      status: subscription?.status || 'inactive',
      starts_at: subscription?.starts_at || new Date().toISOString(),
      expires_at: subscription?.expires_at || null,
    }, quota, downloads, req.session.csrf_token));
  });

  app.post('/api/v1/downloads/:videoId', requireAuth, (req, res) => {
    const user = req.sessionUser;
    const videoId = req.params.videoId;
    const deviceId = String(req.body?.deviceId || req.headers['x-device-id'] || '').trim();
    const { ipAddress, deviceInformation, browser } = requestMetadata(req);

    const video = database.prepare('SELECT * FROM videos WHERE id = ? AND is_active = 1').get(videoId);
    if (!video) {
      auditAttempt(req, 'video_unavailable', { reason: 'Video not found or unavailable.' });
      return res.status(404).json({ ok: false, error: 'Video not found or unavailable.' });
    }

    const subscription = getActiveSubscription(user.id);
    if (!subscription) {
      auditAttempt(req, 'subscription_inactive', { reason: 'No active subscription found.' });
      return res.status(403).json({ ok: false, error: 'No active subscription found.' });
    }

    if (!validateDeviceRegistration(user.id, deviceId)) {
      auditAttempt(req, 'device_rejected', { reason: 'Device is not registered.' });
      return res.status(403).json({ ok: false, error: 'Device is not authorized for this account.' });
    }

    expireStaleReservations(user.id);
    const duplicate = getRecentDuplicateDownload(user.id, video.id);
    if (duplicate && Date.now() - new Date(duplicate.downloaded_at).getTime() < duplicateWindowMs) {
      if (
        duplicate.status === 'in_progress'
        && !duplicate.transfer_started_at
        && duplicate.device_information === deviceId
      ) {
        auditAttempt(req, 'reservation_reused', {
          reason: 'Reused the existing reservation after a repeated request.',
        }, duplicate.id);
        return res.status(202).json({
          ok: true,
          status: 'queued',
          reused: true,
          downloadId: duplicate.id,
          video: {
            id: video.id,
            title: video.title,
            thumbnailUrl: video.thumbnail_url,
            size: video.file_size_bytes,
          },
          plan: { id: subscription.plan_id, name: subscription.plan_name },
          quota: getRemainingQuota(user.id, subscription),
          fileUrl: `/api/v1/downloads/${duplicate.id}/file`,
        });
      }

      const duplicateId = makeId('dup');
      database.prepare(
        'INSERT INTO download_records (id, user_id, video_id, subscription_id, plan_id, downloaded_at, status, is_duplicate, ip_address, device_information, browser, file_size_bytes, failure_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        duplicateId,
        user.id,
        video.id,
        subscription.id,
        subscription.plan_id,
        getIsoDateTime(Date.now()),
        'duplicate',
        1,
        ipAddress,
        deviceId || 'unknown',
        browser,
        video.file_size_bytes,
        'Duplicate download suppressed within duplicate window.',
      );
      auditAttempt(req, 'duplicate_rejected', {
        duplicateWindowMs,
        existingDownloadId: duplicate.id,
      }, duplicate.id);
      return res.status(409).json({
        ok: false,
        error: 'Duplicate download prevented. Download already completed within the configured window.',
        duplicateWindowMs,
      });
    }

    const quota = getRemainingQuota(user.id, subscription);
    if (quota.remaining <= 0) {
      const failedId = makeId('quota');
      database.prepare(
        'INSERT INTO download_records (id, user_id, video_id, subscription_id, plan_id, downloaded_at, status, is_duplicate, ip_address, device_information, browser, file_size_bytes, failure_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        failedId,
        user.id,
        video.id,
        subscription.id,
        subscription.plan_id,
        getIsoDateTime(Date.now()),
        'failed',
        0,
        ipAddress,
        deviceId || 'unknown',
        browser,
        video.file_size_bytes,
        'Daily quota exhausted.',
      );
      auditAttempt(req, 'quota_rejected', quota, failedId);
      return res.status(403).json({ ok: false, error: 'Daily quota exhausted.', quota });
    }

    const runAtomicDownload = () => {
      database.exec('BEGIN IMMEDIATE');
      try {
        const latestQuota = getRemainingQuota(user.id, subscription);
        if (latestQuota.remaining <= 0) {
          throw new Error('quota_exhausted');
        }

        const duplicateNow = getRecentDuplicateDownload(user.id, video.id);
        if (duplicateNow && Date.now() - new Date(duplicateNow.downloaded_at).getTime() < duplicateWindowMs) {
          throw new Error('duplicate_download');
        }

        const recordId = makeId('dl');
        database.prepare(
          'INSERT INTO download_records (id, user_id, video_id, subscription_id, plan_id, downloaded_at, status, is_duplicate, ip_address, device_information, browser, file_size_bytes, failure_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(
          recordId,
          user.id,
          video.id,
          subscription.id,
          subscription.plan_id,
          getIsoDateTime(Date.now()),
          'in_progress',
          0,
          ipAddress,
          deviceId || 'unknown',
          browser,
          video.file_size_bytes,
          null,
        );

        appendHistory(recordId, 'download_reserved', `Authorized using ${subscription.plan_name}.`);
        auditAttempt(req, 'reserved', { plan: subscription.plan_name, quota: latestQuota }, recordId);

        database.exec('COMMIT');
        return recordId;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    };

    try {
      const recordId = runAtomicDownload();
      return res.status(202).json({
        ok: true,
        status: 'queued',
        downloadId: recordId,
        video: {
          id: video.id,
          title: video.title,
          thumbnailUrl: video.thumbnail_url,
          size: video.file_size_bytes,
        },
        plan: { id: subscription.plan_id, name: subscription.plan_name },
        quota: getRemainingQuota(user.id, subscription),
        fileUrl: `/api/v1/downloads/${recordId}/file`,
      });
    } catch (error) {
      if (error.message === 'duplicate_download') {
        auditAttempt(req, 'duplicate_rejected', { duplicateWindowMs });
        return res.status(409).json({ ok: false, error: 'Duplicate download prevented.' });
      }
      if (error.message === 'quota_exhausted') {
        auditAttempt(req, 'quota_rejected', quota);
        return res.status(403).json({ ok: false, error: 'Daily quota exhausted.', quota });
      }
      auditAttempt(req, 'reservation_failed', { reason: error.message });
      return res.status(500).json({ ok: false, error: 'Unable to authorize this download.' });
    }
  });

  app.get('/api/v1/downloads/:downloadId/file', requireAuth, (req, res) => {
    auditAttempt(req, 'file_rejected', { reason: 'File retrieval requires a CSRF-protected POST request.' });
    return res.status(405).json({ ok: false, error: 'Use an authorized POST request to retrieve this file.' });
  });

  app.post('/api/v1/downloads/:downloadId/file', requireAuth, (req, res) => {
    const user = req.sessionUser;
    const downloadId = req.params.downloadId;
    expireStaleReservations(user.id);
    const record = database.prepare(
      `SELECT dr.*, v.title, v.media_path, v.mime_type, v.is_active, p.name AS plan_name
       FROM download_records dr
       JOIN videos v ON v.id = dr.video_id
       JOIN plans p ON p.id = dr.plan_id
       WHERE dr.id = ? AND dr.user_id = ?`,
    ).get(downloadId, user.id);

    if (!record) {
      auditAttempt(req, 'file_rejected', { reason: 'Download record not found.' }, downloadId);
      return res.status(404).json({ ok: false, error: 'Download record not found.' });
    }

    const subscription = getActiveSubscription(user.id);
    if (!subscription || subscription.id !== record.subscription_id) {
      auditAttempt(req, 'file_rejected', { reason: 'Subscription is no longer active.' }, downloadId);
      return res.status(403).json({ ok: false, error: 'Subscription no longer active.' });
    }

    if (!record.is_active || !validateDeviceRegistration(user.id, record.device_information)) {
      auditAttempt(req, 'file_rejected', { reason: 'Video or registered device is no longer authorized.' }, downloadId);
      return res.status(403).json({ ok: false, error: 'Video or device is no longer authorized.' });
    }

    if (record.status !== 'in_progress' || record.transfer_started_at) {
      auditAttempt(req, 'file_rejected', { reason: `Download record is ${record.status}.` }, downloadId);
      return res.status(409).json({ ok: false, error: 'This download reservation is no longer available.' });
    }

    if (!record.media_path) {
      database.prepare(
        `UPDATE download_records SET status = 'failed', failure_reason = ? WHERE id = ? AND status = 'in_progress'`,
      ).run('Video file path is missing.', downloadId);
      appendHistory(downloadId, 'download_failed', 'Video file path is missing.');
      auditAttempt(req, 'transfer_failed', { reason: 'Video file path is missing.' }, downloadId);
      return res.status(404).json({ ok: false, error: 'Downloaded video file is unavailable.' });
    }

    const filePath = path.resolve(videoDirectory, record.media_path);
    const relativePath = path.relative(videoDirectory, filePath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      auditAttempt(req, 'file_rejected', { reason: 'Invalid video file path.' }, downloadId);
      database.prepare(
        `UPDATE download_records SET status = 'failed', failure_reason = ? WHERE id = ? AND status = 'in_progress'`,
      ).run('Invalid video file path.', downloadId);
      appendHistory(downloadId, 'download_failed', 'Invalid video file path.');
      return res.status(404).json({ ok: false, error: 'Downloaded video file is unavailable.' });
    }

    if (!fs.existsSync(filePath)) {
      database.prepare(
        `UPDATE download_records SET status = 'failed', failure_reason = ? WHERE id = ? AND status = 'in_progress'`,
      ).run('File missing on disk.', downloadId);
      appendHistory(downloadId, 'download_failed', 'File missing on disk.');
      auditAttempt(req, 'transfer_failed', { reason: 'File missing on disk.' }, downloadId);
      return res.status(404).json({ ok: false, error: 'Downloaded video file is missing.' });
    }

    let fileSize;
    try {
      const fileStat = fs.statSync(filePath);
      if (!fileStat.isFile()) throw new Error('Video path is not a file.');
      fileSize = fileStat.size;
    } catch (error) {
      database.prepare(
        `UPDATE download_records SET status = 'failed', failure_reason = ? WHERE id = ? AND status = 'in_progress'`,
      ).run(error.message, downloadId);
      appendHistory(downloadId, 'download_failed', error.message);
      auditAttempt(req, 'transfer_failed', { reason: error.message }, downloadId);
      return res.status(404).json({ ok: false, error: 'Downloaded video file is unavailable.' });
    }

    database.exec('BEGIN IMMEDIATE');
    try {
      const claimed = database.prepare(
        `UPDATE download_records
         SET transfer_started_at = ?, transfer_heartbeat_at = ?, file_size_bytes = ?
         WHERE id = ? AND user_id = ? AND status = 'in_progress' AND transfer_started_at IS NULL`,
      ).run(getIsoDateTime(Date.now()), getIsoDateTime(Date.now()), fileSize, downloadId, user.id);
      if (!claimed.changes) {
        database.exec('ROLLBACK');
        auditAttempt(req, 'file_rejected', { reason: 'Download reservation was already claimed.' }, downloadId);
        return res.status(409).json({ ok: false, error: 'This download reservation is no longer available.' });
      }
      database.prepare('UPDATE videos SET file_size_bytes = ? WHERE id = ?')
        .run(fileSize, record.video_id);
      appendHistory(downloadId, 'transfer_started', 'Authorized file transfer started.');
      auditAttempt(req, 'transfer_started', { plan: subscription.plan_name }, downloadId);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      auditAttempt(req, 'transfer_failed', { reason: error.message }, downloadId);
      return res.status(500).json({ ok: false, error: 'Unable to start video transfer.' });
    }

    activeTransfers.add(downloadId);
    let transferSettled = false;
    let transferredBytes = 0;
    const heartbeatIntervalMs = Math.max(100, Math.min(5 * 60 * 1000, reservationTtlMs / 3));
    let lastHeartbeatAt = Date.now();
    const touchTransfer = () => {
      const now = Date.now();
      database.prepare(
        `UPDATE download_records SET transfer_heartbeat_at = ?
         WHERE id = ? AND status = 'in_progress'`,
      ).run(getIsoDateTime(now), downloadId);
      lastHeartbeatAt = now;
    };
    const finishTransfer = (status, reason = null) => {
      if (transferSettled) return;
      transferSettled = true;
      clearInterval(heartbeatTimer);
      activeTransfers.delete(downloadId);
      const completedAt = status === 'completed' ? getIsoDateTime(Date.now()) : null;
      database.prepare(
        `UPDATE download_records
         SET status = ?, completed_at = ?, failure_reason = ?, transfer_heartbeat_at = NULL
         WHERE id = ? AND status = 'in_progress'`,
      ).run(status, completedAt, reason, downloadId);
      appendHistory(
        downloadId,
        status === 'completed' ? 'transfer_finished' : 'transfer_failed',
        status === 'completed'
          ? 'Server finished writing the response; client-side file saving cannot be confirmed.'
          : reason || 'Transfer ended before the server finished writing the response.',
      );
      auditAttempt(req, status === 'completed' ? 'transfer_finished' : 'transfer_failed', {
        reason,
        serverResponseFinished: status === 'completed',
      }, downloadId);
    };
    const heartbeatTimer = setInterval(touchTransfer, heartbeatIntervalMs);
    heartbeatTimer.unref();

    res.once('finish', () => {
      if (transferredBytes !== fileSize) {
        finishTransfer(
          'failed',
          `Unexpected file size: streamed ${transferredBytes} of ${fileSize} bytes.`,
        );
        return;
      }
      finishTransfer('completed');
    });
    res.once('close', () => {
      if (!res.writableFinished) {
        finishTransfer('failed', 'Client disconnected before the response finished.');
      }
    });

    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => {
      transferredBytes += chunk.length;
      const now = Date.now();
      if (now - lastHeartbeatAt >= heartbeatIntervalMs) {
        touchTransfer();
      }
    });
    stream.once('error', (error) => {
      finishTransfer('failed', `File stream error: ${error.message}`);
      if (res.headersSent) {
        res.destroy(error);
      } else {
        res.status(500).json({ ok: false, error: 'Unable to read the video file.' });
      }
    });
    res.setHeader('Content-Type', record.mime_type === 'video/mp4' ? 'video/mp4' : 'application/octet-stream');
    res.setHeader('Content-Length', fileSize);
    res.setHeader('X-VideoVault-Plan', subscription.plan_name);
    res.setHeader('X-StreamNest-Plan', subscription.plan_name);
    res.attachment(`${record.title}.mp4`);
    stream.pipe(res);
  });

  app.get('/api/v1/profile', requireAuth, (req, res) => {
    const user = req.sessionUser;
    const subscription = getActiveSubscription(user.id);
    const quota = getRemainingQuota(user.id, subscription);
    const downloads = database
      .prepare(
        `SELECT dr.*, v.title, v.thumbnail_url, p.name AS plan_name
         FROM download_records dr
         JOIN videos v ON v.id = dr.video_id
         JOIN plans p ON p.id = dr.plan_id
         WHERE dr.user_id = ?
         ORDER BY dr.downloaded_at DESC`,
      )
      .all(user.id);

    res.json({ ok: true, user: { id: user.id, email: user.email }, subscription, quota, downloads });
  });

  return app;
}

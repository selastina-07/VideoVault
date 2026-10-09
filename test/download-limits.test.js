import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { initializeDatabase } from '../src/database.js';

async function createTestApp(options = {}) {
  const { omitSampleFiles = false, ...appOptions } = options;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project2-downloads-'));
  const videoDirectory = path.join(root, 'videos');
  fs.mkdirSync(videoDirectory, { recursive: true });
  if (!omitSampleFiles) {
    for (const name of ['alpha-summit.mp4', 'mountain-drift.mp4', 'city-pulse.mp4', 'night-ride.mp4']) {
      fs.copyFileSync(
        path.join(process.cwd(), 'storage', 'videos', name),
        path.join(videoDirectory, name),
      );
    }
  }
  const database = initializeDatabase(':memory:');
  const app = createApp(database, {
    videoDirectory,
    sessionTtlMs: 7 * 24 * 60 * 60 * 1000,
    duplicateWindowMs: 24 * 60 * 60 * 1000,
    reservationTtlMs: 30 * 60 * 1000,
    secureCookies: false,
    requireRegisteredDevice: true,
    ...appOptions,
  });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  return {
    database,
    root,
    videoDirectory,
    server,
    port: server.address().port,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      database.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function cookieHeader(cookies) {
  return [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

function updateCookies(response, cookies) {
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(';', 1)[0];
    const separator = pair.indexOf('=');
    if (separator !== -1) cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

async function login(appState, email = 'free@streamnest.test', password = 'password123') {
  const cookies = new Map();
  const csrfResponse = await fetch(`http://127.0.0.1:${appState.port}/api/csrf`);
  updateCookies(csrfResponse, cookies);
  const { csrfToken } = await csrfResponse.json();
  const response = await fetch(`http://127.0.0.1:${appState.port}/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': csrfToken,
      cookie: cookieHeader(cookies),
    },
    body: JSON.stringify({ email, password }),
  });
  updateCookies(response, cookies);
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  return { cookies, payload };
}

async function postDownload(appState, session, videoId, deviceId) {
  const response = await fetch(`http://127.0.0.1:${appState.port}/api/v1/downloads/${videoId}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: cookieHeader(session.cookies),
      'x-csrf-token': session.payload.csrfToken,
      'x-device-id': deviceId,
    },
    body: JSON.stringify({ deviceId }),
  });
  return { response, payload: await response.json() };
}

function postFile(appState, session, fileUrl) {
  return fetch(`http://127.0.0.1:${appState.port}${fileUrl}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: cookieHeader(session.cookies),
      'x-csrf-token': session.payload.csrfToken,
    },
    body: JSON.stringify({ csrfToken: session.payload.csrfToken }),
  });
}

test('authorized download streams the file and marks it complete only when the response finishes', async () => {
  const appState = await createTestApp();
  try {
    const session = await login(appState);
    const reservation = await postDownload(appState, session, 'vid_alpha', 'device-free');
    assert.equal(reservation.response.status, 202);
    assert.equal(
      appState.database.prepare('SELECT status FROM download_records WHERE id = ?')
        .get(reservation.payload.downloadId).status,
      'in_progress',
    );

    const response = await postFile(appState, session, reservation.payload.fileUrl);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition'), /attachment/);
    assert.equal(response.headers.get('content-type'), 'video/mp4');
    assert.equal(Number(response.headers.get('content-length')), reservation.payload.video.size);
    const body = Buffer.from(await response.arrayBuffer());
    assert.equal(body.length, reservation.payload.video.size);
    assert.equal(body.toString('ascii', 4, 8), 'ftyp');

    const record = await waitFor(() => {
      const current = appState.database.prepare(
        'SELECT status, completed_at FROM download_records WHERE id = ?',
      ).get(reservation.payload.downloadId);
      return current.status === 'completed' ? current : null;
    });
    assert.ok(record);
    assert.equal(record.status, 'completed');
    assert.ok(record.completed_at);
    const completedDuplicate = await postDownload(appState, session, 'vid_alpha', 'device-free');
    assert.equal(completedDuplicate.response.status, 409);
    const refreshed = await postFile(appState, session, reservation.payload.fileUrl);
    assert.equal(refreshed.status, 409);
    const audit = appState.database.prepare(
      'SELECT outcome FROM download_attempts WHERE download_id = ? ORDER BY attempted_at',
    ).all(reservation.payload.downloadId).map((row) => row.outcome);
    assert.deepEqual(audit.slice(0, 3), ['reserved', 'transfer_started', 'transfer_finished']);
    assert.ok(audit.includes('duplicate_rejected'));
    assert.ok(audit.includes('file_rejected'));
  } finally {
    await appState.close();
  }
});

test('Free quota is enforced and repeated requests reuse one reservation without double counting', async () => {
  const appState = await createTestApp();
  try {
    const session = await login(appState);
    const first = await postDownload(appState, session, 'vid_alpha', 'device-free');
    assert.equal(first.response.status, 202);

    const duplicate = await postDownload(appState, session, 'vid_alpha', 'device-free');
    assert.equal(duplicate.response.status, 202);
    assert.equal(duplicate.payload.reused, true);
    assert.equal(duplicate.payload.downloadId, first.payload.downloadId);

    const secondVideo = await postDownload(appState, session, 'vid_beta', 'device-free');
    assert.equal(secondVideo.response.status, 403);
    assert.equal(secondVideo.payload.error, 'Daily quota exhausted.');
    assert.equal(
      appState.database.prepare(
        "SELECT COUNT(*) AS count FROM download_records WHERE user_id = 'user_free' AND status = 'in_progress'",
      ).get().count,
      1,
    );
    assert.ok(appState.database.prepare(
      "SELECT COUNT(*) AS count FROM download_attempts WHERE outcome = 'quota_rejected'",
    ).get().count > 0);
  } finally {
    await appState.close();
  }
});

test('simultaneous requests cannot over-reserve a Free account quota', async () => {
  const appState = await createTestApp();
  try {
    const session = await login(appState);
    const results = await Promise.all([
      postDownload(appState, session, 'vid_alpha', 'device-free'),
      postDownload(appState, session, 'vid_beta', 'device-free'),
    ]);
    assert.deepEqual(results.map((result) => result.response.status).sort(), [202, 403]);
    assert.equal(
      appState.database.prepare(
        "SELECT COUNT(*) AS count FROM download_records WHERE user_id = 'user_free' AND status = 'in_progress'",
      ).get().count,
      1,
    );
  } finally {
    await appState.close();
  }
});

test('expired or not-yet-started subscriptions cannot reserve downloads', async () => {
  const appState = await createTestApp();
  try {
    const session = await login(appState);
    appState.database.prepare(
      'UPDATE subscriptions SET starts_at = ? WHERE user_id = ? AND status = ?',
    ).run(new Date(Date.now() + 60_000).toISOString(), 'user_free', 'active');

    const response = await postDownload(appState, session, 'vid_alpha', 'device-free');
    assert.equal(response.response.status, 403);
    assert.equal(response.payload.error, 'No active subscription found.');
    assert.equal(
      appState.database.prepare(
        "SELECT COUNT(*) AS count FROM download_records WHERE user_id = 'user_free'",
      ).get().count,
      0,
    );
    assert.equal(
      appState.database.prepare(
        "SELECT COUNT(*) AS count FROM download_attempts WHERE user_id = 'user_free' AND outcome = 'subscription_inactive'",
      ).get().count,
      1,
    );
  } finally {
    await appState.close();
  }
});

test('unauthorized users cannot access download records or make state changes without CSRF', async () => {
  const appState = await createTestApp();
  try {
    const fileResponse = await fetch(`http://127.0.0.1:${appState.port}/api/v1/downloads/unknown/file`);
    assert.equal(fileResponse.status, 401);

    const csrfResponse = await fetch(`http://127.0.0.1:${appState.port}/api/csrf`);
    const cookies = new Map();
    updateCookies(csrfResponse, cookies);
    const { csrfToken } = await csrfResponse.json();
    const loginResponse = await fetch(`http://127.0.0.1:${appState.port}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieHeader(cookies) },
      body: JSON.stringify({ email: 'free@streamnest.test', password: 'password123' }),
    });
    assert.equal(loginResponse.status, 403);

    const owner = await login(appState);
    const missingCsrfResponse = await fetch(
      `http://127.0.0.1:${appState.port}/api/v1/downloads/vid_alpha`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: cookieHeader(owner.cookies),
          'x-device-id': 'device-free',
        },
        body: JSON.stringify({ deviceId: 'device-free' }),
      },
    );
    assert.equal(missingCsrfResponse.status, 403);

    const reserved = await postDownload(appState, owner, 'vid_alpha', 'device-free');
    const otherUser = await login(appState, 'gold@streamnest.test');
    const otherUserResponse = await postFile(appState, otherUser, reserved.payload.fileUrl);
    assert.equal(otherUserResponse.status, 404);
  } finally {
    await appState.close();
  }
});

test('failed file transfer is audited and releases its quota reservation', async () => {
  const appState = await createTestApp();
  try {
    const session = await login(appState);
    const reservation = await postDownload(appState, session, 'vid_alpha', 'device-free');
    fs.unlinkSync(path.join(appState.videoDirectory, 'alpha-summit.mp4'));
    const response = await postFile(appState, session, reservation.payload.fileUrl);
    assert.equal(response.status, 404);
    assert.equal(
      appState.database.prepare('SELECT status FROM download_records WHERE id = ?')
        .get(reservation.payload.downloadId).status,
      'failed',
    );
    assert.equal(
      appState.database.prepare(
        "SELECT COUNT(*) AS count FROM download_attempts WHERE download_id = ? AND outcome = 'transfer_failed'",
      ).get(reservation.payload.downloadId).count,
      1,
    );
    const retry = await postDownload(appState, session, 'vid_beta', 'device-free');
    assert.equal(retry.response.status, 202);
  } finally {
    await appState.close();
  }
});

test('client-interrupted transfer fails the reservation and releases quota', async () => {
  const appState = await createTestApp();
  try {
    const session = await login(appState);
    const filePath = path.join(appState.videoDirectory, 'alpha-summit.mp4');
    const largeSize = 256 * 1024 * 1024;
    fs.truncateSync(filePath, largeSize);
    appState.database.prepare(
      'UPDATE videos SET file_size_bytes = ? WHERE id = ?',
    ).run(largeSize, 'vid_alpha');

    const reservation = await postDownload(appState, session, 'vid_alpha', 'device-free');
    const response = await postFile(appState, session, reservation.payload.fileUrl);
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const firstChunk = await reader.read();
    assert.equal(firstChunk.done, false);
    await reader.cancel();

    const failed = await waitFor(() => {
      const current = appState.database.prepare(
        'SELECT status FROM download_records WHERE id = ?',
      ).get(reservation.payload.downloadId);
      return current.status === 'failed' ? current : null;
    });
    assert.ok(failed, 'interrupted response should release the in-progress reservation');
    assert.ok(appState.database.prepare(
      "SELECT COUNT(*) AS count FROM download_attempts WHERE download_id = ? AND outcome = 'transfer_failed'",
    ).get(reservation.payload.downloadId).count > 0);

    const retry = await postDownload(appState, session, 'vid_beta', 'device-free');
    assert.equal(retry.response.status, 202);
  } finally {
    await appState.close();
  }
});

test('stale abandoned reservations expire and release quota', async () => {
  const appState = await createTestApp({ reservationTtlMs: 1000 });
  try {
    const session = await login(appState);
    const reservation = await postDownload(appState, session, 'vid_alpha', 'device-free');
    appState.database.prepare(
      'UPDATE download_records SET downloaded_at = ? WHERE id = ?',
    ).run(new Date(Date.now() - 5000).toISOString(), reservation.payload.downloadId);

    const retry = await postDownload(appState, session, 'vid_beta', 'device-free');
    assert.equal(retry.response.status, 202);
    assert.equal(
      appState.database.prepare('SELECT status FROM download_records WHERE id = ?')
        .get(reservation.payload.downloadId).status,
      'failed',
    );
    assert.ok(appState.database.prepare(
      "SELECT COUNT(*) AS count FROM download_history WHERE download_id = ? AND event_type = 'reservation_expired'",
    ).get(reservation.payload.downloadId).count > 0);
  } finally {
    await appState.close();
  }
});

test('profile still renders download history and plan quota', async () => {
  const appState = await createTestApp();
  try {
    assert.deepEqual(
      appState.database.prepare('SELECT id, daily_limit FROM plans ORDER BY daily_limit').all()
        .map((row) => ({ id: row.id, daily_limit: row.daily_limit })),
      [
        { id: 'free', daily_limit: 1 },
        { id: 'bronze', daily_limit: 3 },
        { id: 'silver', daily_limit: 5 },
        { id: 'gold', daily_limit: 10 },
      ],
    );
    const session = await login(appState, 'gold@streamnest.test');
    const loginPage = await fetch(`http://127.0.0.1:${appState.port}/login`);
    const loginHtml = await loginPage.text();
    assert.match(loginHtml, /VideoVault/);
    assert.match(loginHtml, /Smart Video Download Management System/);
    assert.doesNotMatch(loginHtml, /StreamNest/i);

    const response = await fetch(`http://127.0.0.1:${appState.port}/profile`, {
      headers: { cookie: cookieHeader(session.cookies) },
    });

    test('seeded demo files are real MP4 containers and their stored sizes match disk', async () => {
      const appState = await createTestApp();
      try {
        const videos = appState.database.prepare(
          'SELECT id, media_path, mime_type, file_size_bytes FROM videos ORDER BY id',
        ).all();
        assert.equal(videos.length, 4);
        for (const video of videos) {
          const filePath = path.join(appState.videoDirectory, video.media_path);
          const bytes = fs.readFileSync(filePath);
          assert.equal(bytes.toString('ascii', 4, 8), 'ftyp', `${video.media_path} should be an ISO BMFF/MP4`);
          assert.ok(bytes.includes(Buffer.from('moov')), `${video.media_path} should have a movie index`);
          assert.ok(bytes.includes(Buffer.from('mdat')), `${video.media_path} should contain media data`);
          assert.equal(video.mime_type, 'video/mp4');
          assert.equal(video.file_size_bytes, bytes.length);
        }
      } finally {
        await appState.close();
      }
    });

    test('seeding does not create fake MP4 contents when sample assets are absent', async () => {
      const appState = await createTestApp({ omitSampleFiles: true });
      try {
        for (const name of ['alpha-summit.mp4', 'mountain-drift.mp4', 'city-pulse.mp4', 'night-ride.mp4']) {
          assert.equal(fs.existsSync(path.join(appState.videoDirectory, name)), false);
        }
        assert.equal(
          appState.database.prepare('SELECT file_size_bytes FROM videos WHERE id = ?')
            .get('vid_alpha').file_size_bytes,
          0,
        );
      } finally {
        await appState.close();
      }
    });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Downloads/i);
    assert.match(html, /gold/i);
    assert.match(html, /Remaining/i);
    assert.match(html, /VideoVault/);
    assert.doesNotMatch(html, /StreamNest/i);
    const videosResponse = await fetch(`http://127.0.0.1:${appState.port}/videos`, {
      headers: { cookie: cookieHeader(session.cookies) },
    });
    const videosHtml = await videosResponse.text();
    assert.match(videosHtml, /transferForm\.submit\(\)/);
    assert.match(videosHtml, /X-CSRF-Token/);
    assert.match(videosHtml, /VideoVault/);
    assert.match(videosHtml, /Video Library \| VideoVault/);
    assert.doesNotMatch(videosHtml, /StreamNest/i);

    const aliasedSession = await login(appState, 'free@videovault.test');
    const aliasedProfile = await fetch(`http://127.0.0.1:${appState.port}/api/v1/profile`, {
      headers: { cookie: cookieHeader(aliasedSession.cookies) },
    });
    assert.equal(aliasedProfile.status, 200);
    assert.equal((await aliasedProfile.json()).user.id, 'user_free');
  } finally {
    await appState.close();
  }
});

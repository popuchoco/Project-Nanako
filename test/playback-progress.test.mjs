import test from 'node:test';
import assert from 'node:assert/strict';
import { formatPlaybackTime, shouldResumePlayback } from '../public/playback-progress.mjs';

test('resume requires a valid matching duration and a meaningful unfinished position', () => {
  assert.equal(shouldResumePlayback({ position: 85, duration: 210 }, 211), true);
  assert.equal(shouldResumePlayback({ position: 85, duration: 210 }, 225), false);
  assert.equal(shouldResumePlayback({ position: 4, duration: 100 }, 100), false);
  assert.equal(shouldResumePlayback({ position: 95, duration: 100 }, 100), false);
  assert.equal(shouldResumePlayback({ position: 99, duration: 100 }, 100), false);
  assert.equal(shouldResumePlayback(null, 100), false);
  assert.equal(shouldResumePlayback({ position: Number.NaN, duration: 100 }, 100), false);
  assert.equal(shouldResumePlayback({ position: 30, duration: 0 }, 100), false);
});

test('playback time formatting is stable for minute and hour durations', () => {
  assert.equal(formatPlaybackTime(85.8), '1:25');
  assert.equal(formatPlaybackTime(3661), '1:01:01');
  assert.equal(formatPlaybackTime(Number.NaN), '0:00');
});

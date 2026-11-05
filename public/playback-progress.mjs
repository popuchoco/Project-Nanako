export function shouldResumePlayback(progress, duration) {
  if (!progress || !Number.isFinite(progress.position) || progress.position < 5
    || !Number.isFinite(progress.duration) || progress.duration <= 0
    || !Number.isFinite(duration) || duration <= 0) return false;
  const durationDifference = Math.abs(progress.duration - duration);
  return durationDifference <= Math.max(3, duration * 0.05)
    && progress.position < duration - 1 && progress.position / progress.duration < 0.95;
}

export function formatPlaybackTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`;
}

export function isAlertDue(now, alertCount, nextAlertAt) {
  if (alertCount === 0 || !nextAlertAt) return true;
  const dueAt = Date.parse(nextAlertAt);
  return !Number.isFinite(dueAt) || Date.parse(now) >= dueAt;
}

export function nextAlertDelayMinutes(completedAlertCount) {
  if (completedAlertCount < 3) return 60;
  if (completedAlertCount < 6) return 120;
  return 240;
}

export function addMinutes(value, minutes) {
  return new Date(Date.parse(value) + minutes * 60_000).toISOString();
}

/** Backend IANA zones can include names unsupported by a browser's Intl runtime. */
export function safeAccountTimeZone(timeZone?: string): string {
  try {
    const zone = timeZone || 'Asia/Shanghai';
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(0);
    return zone;
  } catch {
    return 'Asia/Shanghai';
  }
}

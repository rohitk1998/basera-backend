export function namesMatch(a: string, b: string): boolean {
  const words = (n: string) => n.toUpperCase().replace(/[^A-Z\s]/g, ' ').split(/\s+/).filter(Boolean);
  const [short, long] = [words(a), words(b)].sort((x, y) => x.length - y.length);
  if (short.length === 0) return false;
  const pool = [...long];
  return short.every((w) => {
    const i = pool.findIndex(
      (p) => p === w || (w.length === 1 && p.startsWith(w)) || (p.length === 1 && w.startsWith(p)),
    );
    if (i === -1) return false;
    pool.splice(i, 1);
    return true;
  });
}

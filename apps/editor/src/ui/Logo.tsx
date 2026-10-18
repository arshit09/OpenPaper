export function Logo({ size = 22, withText = true }: { size?: number; withText?: boolean }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontWeight: 650, fontSize: 14, letterSpacing: '-0.01em' }}>
      <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
        <rect width="64" height="64" rx="14" fill="currentColor" />
        <path d="M20 14h16l12 12v24a4 4 0 0 1-4 4H20a4 4 0 0 1-4-4V18a4 4 0 0 1 4-4z" fill="var(--op-panel)" />
        <circle cx="30" cy="38" r="7" fill="none" stroke="currentColor" strokeWidth="3.5" />
      </svg>
      {withText && <span>OpenPaper</span>}
    </span>
  );
}

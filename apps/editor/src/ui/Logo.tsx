// The OpenPaper mark: a disc of paper with one edge peeled back (masters in docs/brand/logo).
// The sheet follows the text colour, so it flips with the theme; the fold stays brand grey.
const SHEET = 'M83.55 0.18A108 108 0 1 0 215.82 132.45Z';
const FOLD = 'M83.55 0.18A108 108 0 0 0 215.82 132.45Z';
const WORDMARK =
  'M354.88 112A49.44 49.44 0 1 1 256 112A49.44 49.44 0 1 1 354.88 112ZM337.6 112A32.16 32.16 0 1 0 273.28 112A32.16 32.16 0 1 0 337.6 112ZM465.28 112A49.44 49.44 0 1 1 366.4 112A49.44 49.44 0 1 1 465.28 112ZM448 112A32.16 32.16 0 1 0 383.68 112A32.16 32.16 0 1 0 448 112ZM366.4 64H383.68V202.24H366.4ZM560.1 145.08A49.44 49.44 0 1 1 572.8 112L555.52 112A32.16 32.16 0 1 0 547.26 133.52ZM482.56 104.4H572.13V119.6H482.56ZM583.36 64H600.64V160H583.36ZM583.36 109.6A47.04 47.04 0 0 1 677.44 109.6L660.16 109.6A29.76 29.76 0 0 0 600.64 109.6ZM660.16 109.6H677.44V160H660.16ZM790.72 112A49.44 49.44 0 1 1 691.84 112A49.44 49.44 0 1 1 790.72 112ZM773.44 112A32.16 32.16 0 1 0 709.12 112A32.16 32.16 0 1 0 773.44 112ZM691.84 64H709.12V202.24H691.84ZM898.24 112A49.44 49.44 0 1 1 799.36 112A49.44 49.44 0 1 1 898.24 112ZM880.96 112A32.16 32.16 0 1 0 816.64 112A32.16 32.16 0 1 0 880.96 112ZM880.96 64H898.24V160H880.96ZM1011.52 112A49.44 49.44 0 1 1 912.64 112A49.44 49.44 0 1 1 1011.52 112ZM994.24 112A32.16 32.16 0 1 0 929.92 112A32.16 32.16 0 1 0 994.24 112ZM912.64 64H929.92V202.24H912.64ZM1106.34 145.08A49.44 49.44 0 1 1 1119.04 112L1101.76 112A32.16 32.16 0 1 0 1093.5 133.52ZM1028.8 104.4H1118.37V119.6H1028.8ZM1129.6 64H1146.88V160H1129.6ZM1129.6 107.68A45.12 45.12 0 0 1 1197.28 68.61L1188.64 83.57A27.84 27.84 0 0 0 1146.88 107.68Z';
const FOLD_COLOR = '#8c8c8c';

export function Logo({ size = 22, withText = true }: { size?: number; withText?: boolean }) {
  const width = withText ? 1198 : 216;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center' }}>
      <svg
        width={(size * width) / 216}
        height={size}
        viewBox={`0 0 ${width} 216`}
        {...(withText ? { role: 'img', 'aria-label': 'OpenPaper' } : { 'aria-hidden': true })}
      >
        <path d={SHEET} fill="currentColor" />
        <path d={FOLD} fill={FOLD_COLOR} />
        {withText && <path d={WORDMARK} fill="currentColor" />}
      </svg>
    </span>
  );
}

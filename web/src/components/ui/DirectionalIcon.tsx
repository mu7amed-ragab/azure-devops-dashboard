import { useLang } from '@/lib/i18n/useLang';

interface DirectionalIconProps {
  children: React.ReactNode;
  className?: string;
}

/**
 * Wraps directional icons (chevrons, back arrows, paging arrows) and flips them
 * under RTL. Centralizes the flip logic so new usages can't forget.
 *
 * The icon itself should be an SVG or lucide-react icon component. The wrapper
 * handles the transform based on direction.
 */
export function DirectionalIcon({ children, className = '' }: DirectionalIconProps) {
  const { dir } = useLang();

  return (
    <span
      className={className}
      style={{
        display: 'inline-flex',
        transform: dir === 'rtl' ? 'scaleX(-1)' : undefined,
      }}
    >
      {children}
    </span>
  );
}

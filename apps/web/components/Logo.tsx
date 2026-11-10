/** Ragis mark. Single path, filled with currentColor so it follows the text color and theme. */
export const LOGO_PATH = "M626 210 L232 603 L579 572 L720 563 L778 563 L329 642 L329 699 L478 664 L775 600 L820 601 L424 734 L425 798 L817 639 L859 640 L521 822 L521 897 L858 678 L898 679 L618 911 L618 999 L1018 602 Z";

export function LogoMark({ size = 22, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="222 200 806 809" width={size} height={size} className={className} aria-hidden="true" focusable="false">
      <path fill="currentColor" d={LOGO_PATH} />
    </svg>
  );
}

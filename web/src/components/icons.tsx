import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...props }: IconProps): React.ReactElement {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export function SearchIcon(props: IconProps): React.ReactElement {
  return (
    <Icon {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </Icon>
  );
}

export function SunIcon(props: IconProps): React.ReactElement {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </Icon>
  );
}

export function MoonIcon(props: IconProps): React.ReactElement {
  return (
    <Icon {...props}>
      <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" />
    </Icon>
  );
}

export function XIcon(props: IconProps): React.ReactElement {
  return (
    <Icon {...props}>
      <path d="M18 6 6 18M6 6l12 12" />
    </Icon>
  );
}

export function RefreshIcon(props: IconProps): React.ReactElement {
  return (
    <Icon {...props}>
      <path d="M20 11a8 8 0 1 0-2.3 6.3" />
      <path d="M20 4v7h-7" />
    </Icon>
  );
}

export function CopyIcon(props: IconProps): React.ReactElement {
  return (
    <Icon {...props}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </Icon>
  );
}

export function CheckIcon(props: IconProps): React.ReactElement {
  return (
    <Icon {...props}>
      <path d="m5 12 4 4L19 6" />
    </Icon>
  );
}

export function NetworkIcon(props: IconProps): React.ReactElement {
  return (
    <Icon {...props}>
      <rect x="3" y="3" width="6" height="6" rx="1.5" />
      <rect x="15" y="3" width="6" height="6" rx="1.5" />
      <rect x="9" y="15" width="6" height="6" rx="1.5" />
      <path d="M9 6h6M6 9v3h12V9M12 12v3" />
    </Icon>
  );
}

export function FlameIcon(props: IconProps): React.ReactElement {
  return (
    <Icon {...props}>
      <path d="M12 22c4.4 0 7-2.8 7-6.5 0-2.8-1.6-5-3.6-7.1C14 7 12.8 4.9 13 2c-3.3 1.3-5.4 4-5.4 7.2 0 1.3.4 2.5 1.1 3.5-1.3-.3-2.2-1.2-2.7-2.4C4.9 11.7 4 13.5 4 15.5 4 19.2 7.6 22 12 22Z" />
    </Icon>
  );
}

export function GridIcon(props: IconProps): React.ReactElement {
  return (
    <Icon {...props}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </Icon>
  );
}

export function LayersIcon(props: IconProps): React.ReactElement {
  return (
    <Icon {...props}>
      <path d="m12 3 9 5-9 5-9-5 9-5Z" />
      <path d="m3 13 9 5 9-5" />
      <path d="m3 18 9 5 9-5" />
    </Icon>
  );
}

export function FileTreeIcon(props: IconProps): React.ReactElement {
  return (
    <Icon {...props}>
      <path d="M4 4h5l2 3h9v13H4V4Z" />
      <path d="M8 14h8M8 17h5" />
    </Icon>
  );
}

export function AlertIcon(props: IconProps): React.ReactElement {
  return (
    <Icon {...props}>
      <path d="M12 3 2.7 20h18.6L12 3Z" />
      <path d="M12 9v5M12 17.5v.5" />
    </Icon>
  );
}

export function ArrowRightIcon(props: IconProps): React.ReactElement {
  return (
    <Icon {...props}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </Icon>
  );
}

export function ArrowLeftIcon(props: IconProps): React.ReactElement {
  return (
    <Icon {...props}>
      <path d="M19 12H5M11 18l-6-6 6-6" />
    </Icon>
  );
}

export function ChevronDownIcon(props: IconProps): React.ReactElement {
  return (
    <Icon {...props}>
      <path d="m6 9 6 6 6-6" />
    </Icon>
  );
}

export function PanelIcon(props: IconProps): React.ReactElement {
  return (
    <Icon {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
    </Icon>
  );
}

export function BracesIcon(props: IconProps): React.ReactElement {
  return (
    <Icon {...props}>
      <path d="M8 3H6a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h2M16 3h2a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-2" />
    </Icon>
  );
}

export function ZapIcon(props: IconProps): React.ReactElement {
  return (
    <Icon {...props}>
      <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" />
    </Icon>
  );
}

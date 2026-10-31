import type { ReactNode, SVGProps } from 'react';

export type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function makeIcon(children: ReactNode) {
  return function Icon({ size = 18, ...props }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        {...props}
      >
        {children}
      </svg>
    );
  };
}

export const SendIcon = makeIcon(
  <>
    <path d="M22 2 11 13" />
    <path d="M22 2 15 22l-4-9-9-4 20-7z" />
  </>,
);

export const ChatIcon = makeIcon(
  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
);

export const ShieldIcon = makeIcon(
  <>
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    <path d="m9 12 2 2 4-4" />
  </>,
);

export const LockIcon = makeIcon(
  <>
    <rect x="4" y="10" width="16" height="11" rx="2" />
    <path d="M8 10V7a4 4 0 0 1 8 0v3" />
  </>,
);

export const SettingsIcon = makeIcon(
  <>
    <path d="M4 6h16M4 12h16M4 18h16" />
    <circle cx="8" cy="6" r="2" fill="var(--surface, #111)" />
    <circle cx="16" cy="12" r="2" fill="var(--surface, #111)" />
    <circle cx="9" cy="18" r="2" fill="var(--surface, #111)" />
  </>,
);

export const LinkIcon = makeIcon(
  <>
    <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
    <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
  </>,
);

export const CloudIcon = makeIcon(
  <path d="M17.5 19a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.6-1.5A4 4 0 0 0 6 19z" />,
);

export const CloudOffIcon = makeIcon(
  <>
    <path d="M17.5 19a4.5 4.5 0 0 0 1.5-8.7A6 6 0 0 0 8 8" />
    <path d="M6 19a4 4 0 0 1-.8-7.9" />
    <path d="m3 3 18 18" />
  </>,
);

export const WifiIcon = makeIcon(
  <>
    <path d="M5 12.5a10 10 0 0 1 14 0" />
    <path d="M8.5 16a5 5 0 0 1 7 0" />
    <circle cx="12" cy="19.5" r="0.8" fill="currentColor" />
  </>,
);

export const WifiOffIcon = makeIcon(
  <>
    <path d="m3 3 18 18" />
    <path d="M8.5 16a5 5 0 0 1 7 0" />
    <path d="M5 12.5a10 10 0 0 1 4-2.4" />
    <path d="M15 10.1a10 10 0 0 1 4 2.4" />
    <circle cx="12" cy="19.5" r="0.8" fill="currentColor" />
  </>,
);

export const XIcon = makeIcon(
  <>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </>,
);

export const CopyIcon = makeIcon(
  <>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </>,
);

export const CheckIcon = makeIcon(<path d="m5 12 4 4L19 6" />);

export const CheckCheckIcon = makeIcon(
  <>
    <path d="m2 12 4 4L16 6" />
    <path d="m11 15 2 2L23 7" />
  </>,
);

export const ClockIcon = makeIcon(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </>,
);

export const AlertIcon = makeIcon(
  <>
    <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    <path d="M12 9v4" />
    <circle cx="12" cy="17" r="0.8" fill="currentColor" />
  </>,
);

export const RefreshIcon = makeIcon(
  <>
    <path d="M21 12a9 9 0 1 1-2.6-6.4" />
    <path d="M21 3v6h-6" />
  </>,
);

export const LogOutIcon = makeIcon(
  <>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="m16 17 5-5-5-5" />
    <path d="M21 12H9" />
  </>,
);

export const BellIcon = makeIcon(
  <>
    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
    <path d="M10.3 21a2 2 0 0 0 3.4 0" />
  </>,
);

export const BellOffIcon = makeIcon(
  <>
    <path d="M18 8a6 6 0 0 0-9.3-5" />
    <path d="M6 8c0 7-3 7-3 9h13" />
    <path d="M10.3 21a2 2 0 0 0 3.4 0" />
    <path d="m3 3 18 18" />
  </>,
);

export const PaletteIcon = makeIcon(
  <>
    <path d="M12 22a10 10 0 1 1 10-10c0 3-2 4-4 4h-2a3 3 0 0 0-2 5.2c.6.8.1 1.8-2 2.8z" />
    <circle cx="7.5" cy="11.5" r="1" fill="currentColor" />
    <circle cx="10" cy="7" r="1" fill="currentColor" />
    <circle cx="15" cy="7.5" r="1" fill="currentColor" />
    <circle cx="18" cy="11" r="1" fill="currentColor" />
  </>,
);

export const TrashIcon = makeIcon(
  <>
    <path d="M3 6h18" />
    <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M10 11v6M14 11v6" />
  </>,
);

export const InfoIcon = makeIcon(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5" />
    <circle cx="12" cy="8" r="0.8" fill="currentColor" />
  </>,
);

export const ChevronDownIcon = makeIcon(<path d="m6 9 6 6 6-6" />);

export const LoaderIcon = makeIcon(<path d="M21 12a9 9 0 1 1-6.2-8.6" />);

export const UserIcon = makeIcon(
  <>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5" />
  </>,
);

export const LaptopIcon = makeIcon(
  <>
    <rect x="4" y="5" width="16" height="11" rx="2" />
    <path d="M2 20h20" />
  </>,
);

export const ArrowLeftIcon = makeIcon(
  <>
    <path d="M19 12H5" />
    <path d="m12 19-7-7 7-7" />
  </>,
);

export const KeyIcon = makeIcon(
  <>
    <circle cx="8" cy="15" r="4" />
    <path d="m10.8 12.2 8.7-8.7" />
    <path d="m17 6 2 2" />
    <path d="m14 9 2 2" />
  </>,
);

export const EyeIcon = makeIcon(
  <>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
    <circle cx="12" cy="12" r="3" />
  </>,
);

export const EyeOffIcon = makeIcon(
  <>
    <path d="M10.6 5.2A11 11 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1" />
    <path d="M6.6 6.7A17 17 0 0 0 2 12s3.5 7 10 7a10 10 0 0 0 4.2-.9" />
    <path d="m3 3 18 18" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
  </>,
);

export const PaperclipIcon = makeIcon(
  <path d="m21 11-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.9-8.9a3.7 3.7 0 0 1 5.2 5.2l-8.9 8.9a1.8 1.8 0 0 1-2.6-2.6l8.2-8.2" />,
);

export const ReplyIcon = makeIcon(
  <>
    <path d="m9 14-5-5 5-5" />
    <path d="M4 9h10a6 6 0 0 1 6 6v3" />
  </>,
);

export const DownloadIcon = makeIcon(
  <>
    <path d="M12 3v12" />
    <path d="m7 11 5 5 5-5" />
    <path d="M5 21h14" />
  </>,
);

export const FileIcon = makeIcon(
  <>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
  </>,
);

export const MicIcon = makeIcon(
  <>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0" />
    <path d="M12 18v3" />
  </>,
);

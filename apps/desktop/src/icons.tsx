import type { ReactNode } from "react";

function Icon({ children }: { readonly children: ReactNode }) {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 20 20">
      {children}
    </svg>
  );
}

export function PlusIcon() {
  return (
    <Icon>
      <path d="M10 4.25v11.5M4.25 10h11.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" />
    </Icon>
  );
}

export function FolderIcon() {
  return (
    <Icon>
      <path
        d="M2.75 6.5a1.75 1.75 0 0 1 1.75-1.75h3.1l1.5 1.7h6.4a1.75 1.75 0 0 1 1.75 1.75v5.3a1.75 1.75 0 0 1-1.75 1.75H4.5a1.75 1.75 0 0 1-1.75-1.75V6.5Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
    </Icon>
  );
}

export function ClockIcon() {
  return (
    <Icon>
      <circle cx="10" cy="10" r="6.75" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10 6.8v3.55l2.3 1.35" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
    </Icon>
  );
}

export function SparkIcon() {
  return (
    <Icon>
      <path
        d="m10 3.1 1.55 3.66 3.66 1.55-3.66 1.55L10 13.5l-1.55-3.64L4.8 8.3l3.65-1.55L10 3.1Zm5 8.6.72 1.58 1.58.72-1.58.72L15 16.3l-.72-1.58-1.58-.72 1.58-.72.72-1.58Z"
        fill="currentColor"
      />
    </Icon>
  );
}

export function SettingsIcon() {
  return (
    <Icon>
      <path
        d="M8.8 3.6h2.4l.4 1.6 1.5.62 1.42-.85 1.7 1.7-.86 1.43.63 1.5 1.6.4v2.4l-1.6.4-.63 1.5.86 1.43-1.7 1.7-1.42-.85-1.5.62-.4 1.6H8.8l-.4-1.6-1.5-.62-1.42.85-1.7-1.7.86-1.43-.63-1.5-1.6-.4v-2.4l1.6-.4.63-1.5-.86-1.43 1.7-1.7 1.42.85 1.5-.62.4-1.6Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.25"
      />
      <circle cx="10" cy="10" r="2.3" stroke="currentColor" strokeWidth="1.25" />
    </Icon>
  );
}

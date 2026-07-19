import type { ButtonHTMLAttributes } from "react";

export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

const buttonBaseClass =
  "cursor-pointer border border-studio-border-control bg-studio-control text-studio-text-control enabled:hover:border-studio-accent enabled:hover:bg-studio-control-hover disabled:cursor-not-allowed disabled:opacity-35";

const buttonSizeClasses = {
  default: "rounded-studio-control px-2.5 py-1.75",
  block: "flex-1 rounded-studio-control p-1.25 text-studio-micro",
  reset: "mt-1.75 rounded-studio-control px-1.75 py-1 text-studio-caption",
} as const;

type StudioButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  size?: keyof typeof buttonSizeClasses;
};

export function StudioButton({ className, size = "default", ...props }: StudioButtonProps) {
  return <button className={cx(buttonBaseClass, buttonSizeClasses[size], className)} {...props} />;
}

export const eyebrowClass =
  "text-studio-caption font-extrabold tracking-[0.18em] text-studio-success";

export const statusPillClass =
  "rounded-full border border-[#313a34] px-2.5 py-1.75 text-studio-meta tracking-[0.09em] uppercase";

export const panelHelpClass = "mt-1.25 text-studio-copy leading-[1.45] text-studio-text-subtle";

export const sourceBadgeClass =
  "rounded-full border border-studio-border-badge px-1.5 py-0.75 text-studio-micro tracking-[0.08em] uppercase";

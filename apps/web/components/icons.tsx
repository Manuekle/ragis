// Every icon comes from Hugeicons (free set, stroke-rounded geometry) and is recolored via currentColor.
// The free set only ships the stroke style, so the duotone and solid variants are derived here:
//   stroke  – the icon as drawn by Hugeicons
//   duotone – stroke on top of a 22% tint of the same shapes (the Hugeicons duotone look)
//   solid   – shapes filled with currentColor; use it on glyphs without inner detail (thumbs, bubbles, shields)
import { createElement, type SVGProps } from "react";
import {
  Edit02Icon,
  Plug01Icon,
  RefreshIcon,
  Alert02Icon,
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowLeftRightIcon,
  ArrowRight01Icon,
  ArrowRight02Icon,
  ArrowUp02Icon,
  ArrowUpRight01Icon,
  BubbleChatAddIcon,
  BubbleChatIcon,
  Building01Icon,
  Folder01Icon,
  Calendar03Icon,
  Cancel01Icon,
  ChartBarLineIcon,
  CloudUploadIcon,
  Copy01Icon,
  CopyCheckIcon,
  Delete02Icon,
  DocumentValidationIcon,
  EyeIcon,
  File01Icon,
  Files02Icon,
  LinkSquare02Icon,
  LockKeyIcon,
  Pdf01Icon,
  SendIcon,
  SparklesIcon,
  Loading03Icon,
  Logout03Icon,
  Mail01Icon,
  Moon02Icon,
  Search01Icon,
  SecurityCheckIcon,
  Sun03Icon,
  SunMoonIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  Tick02Icon,
  UnfoldMoreIcon,
  UserIcon,
  Robot01Icon,
  Rocket01Icon,
  PlayIcon,
  PauseIcon,
  GitCompareIcon,
  WrenchIcon,
  MinusSignIcon,
  PlusSignIcon,
  ArrowTurnBackwardIcon,
  Archive01Icon,
  SignatureIcon,
  Share08Icon,
  TaskDone01Icon,
  Layers01Icon,
  Clock01Icon,
  InboxIcon,
  WorkflowSquare03Icon,
  Activity01Icon,
  UserCheck01Icon,
  GitBranchIcon,
  HourglassIcon,
  StopIcon,
  Flag02Icon,
  Download04Icon,
  Link01Icon,
  NewTwitterIcon,
} from "@hugeicons/core-free-icons";

type IconData = readonly (readonly [string, { readonly [key: string]: string | number }])[];
export type IconVariant = "stroke" | "duotone" | "solid";
export type IconProps = Omit<SVGProps<SVGSVGElement>, "strokeWidth"> & { size?: number; strokeWidth?: number; variant?: IconVariant };

function make(data: IconData, base?: { variant?: IconVariant; strokeWidth?: number }) {
  return function Icon({ size = 16, strokeWidth = base?.strokeWidth ?? 1.6, variant = base?.variant ?? "stroke", className, ...rest }: IconProps) {
    const shapes = data.map(([tag, { key: _key, ...attrs }]) => [tag, attrs] as const);
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        data-variant={variant}
        className={className ? `svg-icon ${className}` : "svg-icon"}
        {...rest}
      >
        {variant === "duotone" && (
          <g className="tone" fill="currentColor" stroke="none" opacity={0.22}>
            {shapes.map(([tag, attrs], i) => createElement(tag, { ...attrs, key: i, stroke: "none", fill: "currentColor", strokeWidth: undefined }))}
          </g>
        )}
        {shapes.map(([tag, attrs], i) =>
          createElement(tag, {
            ...attrs,
            key: i,
            strokeWidth: attrs.strokeWidth !== undefined ? strokeWidth : undefined,
            fill: variant === "solid" && attrs.fill !== "currentColor" ? "currentColor" : attrs.fill,
          }),
        )}
      </svg>
    );
  };
}

// Navigation
export const IconChat = make(BubbleChatIcon);
export const IconFiles = make(Files02Icon);
export const IconChart = make(ChartBarLineIcon);
export const IconShield = make(SecurityCheckIcon);
export const IconSwitch = make(ArrowLeftRightIcon);
export const IconLogout = make(Logout03Icon);
export const IconAgent = make(Robot01Icon);
export const IconBuilding = make(Building01Icon);
export const IconRocket = make(Rocket01Icon);
export const IconPlug = make(Plug01Icon);
export const IconRefresh = make(RefreshIcon);

// Agent Studio
export const IconPlay = make(PlayIcon);
export const IconPause = make(PauseIcon);
export const IconCompare = make(GitCompareIcon);
export const IconTool = make(WrenchIcon);
export const IconPlus = make(PlusSignIcon, { strokeWidth: 1.8 });
export const IconMinus = make(MinusSignIcon, { strokeWidth: 1.8 });
export const IconRollback = make(ArrowTurnBackwardIcon);
export const IconArchive = make(Archive01Icon);
export const IconSignature = make(SignatureIcon);
export const IconShare = make(Share08Icon);
export const IconTask = make(TaskDone01Icon);
export const IconLayers = make(Layers01Icon);
export const IconClock = make(Clock01Icon);

// Workflows / HITL
export const IconInbox = make(InboxIcon);
export const IconWorkflow = make(WorkflowSquare03Icon);
export const IconActivity = make(Activity01Icon);
export const IconUserCheck = make(UserCheck01Icon);
export const IconBranch = make(GitBranchIcon);
export const IconHourglass = make(HourglassIcon);
export const IconStop = make(StopIcon);
export const IconFlag = make(Flag02Icon);

// Chevrons and arrows
export const IconChevronDown = make(ArrowDown01Icon, { strokeWidth: 1.8 });
export const IconChevronLeft = make(ArrowLeft01Icon, { strokeWidth: 1.8 });
export const IconChevronRight = make(ArrowRight01Icon, { strokeWidth: 1.8 });
export const IconChevronsUpDown = make(UnfoldMoreIcon);
export const IconArrowUp = make(ArrowUp02Icon, { strokeWidth: 2 });
export const IconArrowRight = make(ArrowRight02Icon, { strokeWidth: 1.8 });
export const IconSend = make(SendIcon, { strokeWidth: 1.8 });
export const IconSparkles = make(SparklesIcon, { strokeWidth: 1.8 });
export const IconExternal = make(LinkSquare02Icon);
export const IconArrowUpRight = make(ArrowUpRight01Icon, { strokeWidth: 1.8 });

// Actions
export const IconCheck = make(Tick02Icon, { strokeWidth: 2 });
export const IconX = make(Cancel01Icon);
export const IconSearch = make(Search01Icon);
export const IconUpload = make(CloudUploadIcon);
export const IconTrash = make(Delete02Icon);
export const IconEdit = make(Edit02Icon);
export const IconCopy = make(Copy01Icon);
export const IconCopyCheck = make(CopyCheckIcon);
export const IconDownload = make(Download04Icon);
export const IconLink = make(Link01Icon);

// Social networks (share buttons)
export const IconXSocial = make(NewTwitterIcon);
/**
 * LinkedIn's own mark: the square with "in" cut out of it, as one solid shape. It takes the text
 * color like every other icon, so it is ink in the light app and near-white in the dark one.
 */
export function IconLinkedIn({ size = 16, className, strokeWidth: _strokeWidth, variant: _variant, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 382 382" fill="currentColor" aria-hidden="true" className={className ? `svg-icon ${className}` : "svg-icon"} {...rest}>
      <path d="M347.445 0H34.555C15.471 0 0 15.471 0 34.555v312.889C0 366.529 15.471 382 34.555 382h312.889C366.529 382 382 366.529 382 347.444V34.555C382 15.471 366.529 0 347.445 0zM118.207 329.844c0 5.554-4.502 10.056-10.056 10.056H65.345c-5.554 0-10.056-4.502-10.056-10.056V150.403c0-5.554 4.502-10.056 10.056-10.056h42.806c5.554 0 10.056 4.502 10.056 10.056v179.441zM86.748 123.432c-22.459 0-40.666-18.207-40.666-40.666S64.289 42.1 86.748 42.1s40.666 18.207 40.666 40.666-18.206 40.666-40.666 40.666zM341.91 330.654c0 5.106-4.14 9.246-9.246 9.246H286.73c-5.106 0-9.246-4.14-9.246-9.246v-84.168c0-12.556 3.683-55.021-32.813-55.021-28.309 0-34.051 29.066-35.204 42.11v97.079c0 5.106-4.139 9.246-9.246 9.246h-44.426c-5.106 0-9.246-4.14-9.246-9.246V149.593c0-5.106 4.14-9.246 9.246-9.246h44.426c5.106 0 9.246 4.14 9.246 9.246v15.655c10.497-15.753 26.097-27.912 59.312-27.912 73.552 0 73.131 68.716 73.131 106.472L341.91 330.654z" />
    </svg>
  );
}
export const IconThumbUp = make(ThumbsUpIcon);
export const IconThumbDown = make(ThumbsDownIcon);
export const IconNewChat = make(BubbleChatAddIcon);

// Objects and status
export const IconCalendar = make(Calendar03Icon);
export const IconFile = make(File01Icon);
export const IconPdf = make(Pdf01Icon);
export const IconDocCheck = make(DocumentValidationIcon);
export const IconLock = make(LockKeyIcon);
export const IconFolder = make(Folder01Icon);
export const IconEye = make(EyeIcon);
export const IconAlert = make(Alert02Icon);
export const IconMail = make(Mail01Icon);
export const IconUser = make(UserIcon);

// Appearance
export const IconSun = make(Sun03Icon);
export const IconMoon = make(Moon02Icon);
export const IconSunMoon = make(SunMoonIcon);

/** Hugeicons loading arc, rotated by .spinner while work is in flight. */
const Loading = make(Loading03Icon, { strokeWidth: 2 });
export function IconSpinner({ size = 16 }: { size?: number }) {
  return <Loading size={size} className="spinner" />;
}

/** Hugeicons tick normalised to pathLength=1 so .t-check can stroke it in. */
export function CheckMark({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className="svg-icon">
      {Tick02Icon.map(([tag, { key: _key, ...attrs }], i) => createElement(tag, { ...attrs, key: i, strokeWidth: 3, pathLength: 1 }))}
    </svg>
  );
}

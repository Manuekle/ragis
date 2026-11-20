"use client";

import Link from "next/link";
import type { ComponentType } from "react";
import type { IconProps } from "./icons";
import { useT } from "@/lib/use-t";

interface PageBreadcrumbsProps {
  section: string;
  href?: string;
  context?: string;
  icon: ComponentType<IconProps>;
}

export function PageBreadcrumbs({ section, href, context, icon: Icon }: PageBreadcrumbsProps) {
  const t = useT();
  return (
    <nav className="crumbs" aria-label={t("Breadcrumb")}>
      {href ? <Link href={href}>{section}</Link> : <strong aria-current={context ? undefined : "page"}>{section}</strong>}
      {context && (
        <>
          <span className="crumb-sep" aria-hidden="true">/</span>
          <span className="crumb-ws" aria-current="page" title={context}>
            <Icon size={15} />
            <span className="crumb-label">{context}</span>
          </span>
        </>
      )}
    </nav>
  );
}

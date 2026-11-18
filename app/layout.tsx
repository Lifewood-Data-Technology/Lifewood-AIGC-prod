import {readVideoCacheBudget} from '../lib/video-cache-policy';
import type { Metadata } from "next";
import "./globals.css";
import "./workbench.css";
import "./lifewood-brand.css";
import "./project-operations.css";
import "./layout-refinements.css";
import "./project-stage-map.css";
import "./team-controls.css";
import "./backup.css";
import "./account-access.css";
import "./account-permissions.css";
import "./quality-review.css";
import "./workflow-refinements.css";
import "./dark-theme.css";
import "./form-dialogs.css";
import "./dialog-layout.css";
import "./filter-layout.css";
import "./editor-workspace.css";
import "./production-flow.css";
import "./pm-workspace.css";
import "./admin-layout.css";
import "./admin-directory.css";
import "./query-filters.css";
import "./business-forms.css";
import "./sales-layout.css";
import "./query-control-consistency.css";
import "./upload-ui.css";
import "./data-list.css";
import "./workbench-lists.css";
import "./role-list-layout.css";
import "./admin-list-layout.css";
import "./customer-import.css";
import "./admin-prototype-alignment.css";
import "./table-presentation.css";
import "./admin-users.css";
import "./sidebar.css";
import "./admin-logs.css";
import "./deseret-production.css";

export const metadata: Metadata = {
  title: "Lifewood AIGC 管理平台",
  icons: { icon: "/favicon.svg" },
  description: "Lifewood AIGC 项目、文件、质检、预览和交付管理平台。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><head><meta name="lifewood-video-cache-mib" content={String(readVideoCacheBudget(process.env)/1024**2)}/></head><body>{children}</body></html>;
}

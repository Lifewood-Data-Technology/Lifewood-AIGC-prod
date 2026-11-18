"use client";

import { useMemo } from "react";
import { portfolioOverview, shanghaiDay } from "../lib/project-progress";

type Row = Record<string, unknown>;
export default function PortfolioOverview({ projects, tasks, quality, feedback, locale, navigate }: {
  projects: Row[]; tasks: Row[]; quality: Row[]; feedback: Row[]; locale: "zh" | "en";
  navigate: (id: string, params?: Record<string, string>) => void;
}) {
  const today = shanghaiDay();
  const data = useMemo(() => portfolioOverview(projects, tasks, quality, feedback, today), [projects, tasks, quality, feedback, today]);
  const zh = locale === "zh";
  const open = (kind: string, period = "") => navigate("projects", { overview: kind, asof: today, ...(period ? { period } : {}) });
  const maxDue = Math.max(1, ...data.due.map(day => day.total));
  const maxTrend = Math.max(1, ...data.weeks.flatMap(week => [week.approved, week.revisions]));
  const maxBucket = Math.max(1, ...data.buckets.map(bucket => bucket.count));
  const currentWeek = data.weeks[3];
  const riskLabels = { overdue: ["制作逾期", "Production overdue"], unassigned: ["待分配", "Awaiting assignment"], revision: ["待修改", "Needs revision"] };
  return <section className="portfolio-overview" aria-label={zh ? "整体项目运行情况" : "Portfolio overview"}>
    <div className="portfolio-scope"><span>{zh ? "当前未归档项目 · 上海时间" : "Current unarchived projects · Shanghai time"} {today}</span>
      <button type="button" className="link-button" onClick={() => navigate("projects")}>{zh ? "进入项目管理 →" : "Open project management →"}</button></div>
    <div className="portfolio-metrics">
      {[
        { label: zh ? "当前项目" : "Current projects", value: data.total, hint: zh ? "未归档、未全部终止" : "Not archived or fully terminated", kind: "all" },
        { label: zh ? "制作未完成" : "Production incomplete", value: data.incomplete, hint: zh ? "含尚未启动与暂停项目" : "Includes unstarted and paused work", kind: "incomplete" },
        { label: zh ? "制作逾期项目" : "Production overdue", value: data.risks[0].count, hint: zh ? "至少一项未完成任务已过期" : "At least one incomplete task is overdue", kind: "overdue" },
        { label: zh ? "本周首次质检通过" : "First approvals this week", value: currentWeek.approved, hint: zh ? "独立视频语言任务数" : "Distinct video-language tasks", kind: "week-approved", period: currentWeek.start },
      ].map(metric => <button type="button" className="portfolio-metric" key={metric.kind} onClick={() => open(metric.kind, metric.period)}>
        <span>{metric.label}</span><strong>{metric.value}</strong><small>{metric.hint}</small>
      </button>)}
    </div>
    <div className="portfolio-chart-grid">
      <section className="portfolio-chart" aria-label={zh ? "项目进度分布" : "Project progress distribution"}>
        <header><h2>{zh ? "项目进度分布" : "Project progress distribution"}</h2><p>{zh ? "完成率按质检通过的语言任务计算" : "Completion is based on quality-approved language tasks"}</p></header>
        <div className="portfolio-buckets">{data.buckets.map(bucket => <button type="button" key={bucket.id} onClick={() => open(bucket.id)} aria-label={`${bucket[locale]}: ${bucket.count} ${zh ? "个项目" : "projects"}`}>
          <span>{bucket[locale]}</span><span className="portfolio-bucket-track"><i style={{ width: `${bucket.count / maxBucket * 100}%`, background: bucket.color }} /></span><strong>{bucket.count}</strong>
        </button>)}</div>
        <p className="portfolio-chart-note">{zh ? "每个项目只计入一个区间；点击区间查看项目。" : "Each project belongs to one band. Select a band to view projects."}</p>
      </section>
      <section className="portfolio-chart" aria-label={zh ? "未来 7 天交期压力" : "Deadline pressure over 7 days"}>
        <header><h2>{zh ? "未来 7 天交期压力" : "Deadline pressure over 7 days"}</h2><p>{zh ? "按任务截止日统计，包含今天" : "By task due date, including today"}</p></header>
        <div className="portfolio-chart-legend"><span><i className="approved" />{zh ? "质检通过" : "Quality approved"}</span><span><i className="unfinished" />{zh ? "尚未完成" : "Incomplete"}</span><small>{zh ? "单位：任务" : "Tasks"}</small></div>
        <div className="portfolio-due-bars">{data.due.map(day => <button type="button" key={day.day} onClick={() => open("due", day.day)} aria-label={`${day.day}: ${day.total} ${zh ? "项任务，质检通过" : "tasks, approved"} ${day.approved}，${zh ? "尚未完成" : "incomplete"} ${day.total - day.approved}`}>
          <strong>{day.total}</strong><span className="portfolio-due-column"><span className="portfolio-due-stack" style={{ height: `${day.total / maxDue * 100}%` }}><i className="unfinished" style={{ flexGrow: day.total - day.approved }} /><i className="approved" style={{ flexGrow: day.approved }} /></span></span>
          <span>{day.day.slice(5).replace("-", "/")}</span><small>{day.day === today ? (zh ? "今天" : "Today") : new Intl.DateTimeFormat(zh ? "zh-CN" : "en", { weekday: "short", timeZone: "UTC" }).format(new Date(`${day.day}T12:00:00Z`))}</small>
        </button>)}</div>
        <p className="portfolio-chart-note">{zh ? "已逾期任务单独计入上方逾期统计，不混入未来交期。" : "Overdue tasks are counted separately above, not in future deadlines."}</p>
      </section>
      <section className="portfolio-chart portfolio-trend" aria-label={zh ? "近 4 周完成与返修" : "Approvals and revisions over 4 weeks"}>
        <header><div><h2>{zh ? "近 4 周完成与返修" : "Approvals and revisions over 4 weeks"}</h2><p>{zh ? "按历史记录统计，本周截至今天" : "Recorded events; current week through today"}</p></div><div className="portfolio-chart-legend"><span><i className="approved" />{zh ? "首次质检通过" : "First quality approval"}</span><span><i className="revision" />{zh ? "发生返修" : "Revision requested"}</span></div></header>
        <div className="portfolio-trend-bars">{data.weeks.map((week, index) => <div className="portfolio-week" key={week.start}>
          <div>{[{ kind: "week-approved", value: week.approved, color: "approved", label: zh ? "首次质检通过" : "First quality approval" }, { kind: "week-revision", value: week.revisions, color: "revision", label: zh ? "发生返修" : "Revision requested" }].map(series => <button type="button" key={series.kind} onClick={() => open(series.kind, week.start)} aria-label={`${week.start} ${series.label}: ${series.value}`}>
            <strong>{series.value}</strong><span className="portfolio-trend-column"><i className={series.color} style={{ height: `${series.value / maxTrend * 100}%` }} /></span>
          </button>)}</div><span>{week.start.slice(5).replace("-", "/")}–{week.end.slice(5).replace("-", "/")}</span><small>{index === 3 ? (zh ? "本周（截至今天）" : "This week to date") : (zh ? "已结束周" : "Completed week")}</small>
        </div>)}</div>
        <p className="portfolio-chart-note">{zh ? "首次通过按任务去重；返修包含质检驳回及客户要求修改，同一任务每周只计一次。历史趋势包含已归档项目，不能用两条柱子的差值表示净完成量。" : "First approval is counted once per task. Revisions include QC and customer requests, once per task per week. History includes archived projects; the difference is not net completion."}</p>
        {data.missingHistory > 0 && <p className="portfolio-chart-note">{zh ? `${data.missingHistory} 项当前已通过任务缺少首次质检时间，未估算计入历史趋势。` : `${data.missingHistory} approved task(s) lack a first-approval date and are not estimated in the history.`}</p>}
      </section>
    </div>
    <div className="portfolio-risk-strip" aria-label={zh ? "异常项目汇总" : "Project exceptions"}>{data.risks.map(risk => <button type="button" key={risk.id} onClick={() => open(risk.id)}><span>{riskLabels[risk.id][zh ? 0 : 1]}</span><strong>{risk.count} <small>{zh ? "个项目" : "projects"}</small></strong><span>{zh ? "占当前项目" : "Of current projects"} {risk.percent}% <b aria-hidden="true">→</b></span></button>)}</div>
    <p className="portfolio-footnote">{zh ? `已排除 ${data.excluded} 个归档或全部终止项目。暂停任务仍计入进度；异常分类可能重叠。` : `${data.excluded} archived or fully terminated project(s) excluded. Paused tasks remain in progress; exception groups can overlap.`}</p>
  </section>;
}

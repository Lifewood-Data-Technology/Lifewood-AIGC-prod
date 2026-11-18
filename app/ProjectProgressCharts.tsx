import { projectChartSummary, type projectStageMap } from "../lib/project-stage-map";
import { ReportedTaskProgress } from "./DailyProductionProgress";

export default function ProjectProgressCharts({ data, locale, onStage, onVideo }: {
  data: ReturnType<typeof projectStageMap>; locale: "zh" | "en";
  onStage: (stage: string) => void; onVideo: (video: string) => void;
}) {
  const zh = locale === "zh";
  const chart = projectChartSummary(data);
  const exceptionLabels: Record<string, string> = { paused: zh ? "已暂停" : "Paused", unknown: zh ? "状态待核对" : "Needs checking" };
  const series = [...data.stages.map(stage => ({ id: stage.id as string, label: stage[locale], count: stage.count })),
    ...data.exceptions.filter(item => item.id !== "terminated" && item.count).map(item => ({ ...item, label: exceptionLabels[item.id] }))];
  const productionLabel = zh ? "质检通过率" : "Quality approval rate";
  const deliveryLabel = zh ? "交付完成" : "Delivery complete";
  return <>
    <div className="psm-owner-strip"><span>{zh ? "项目负责人" : "Project manager"}<strong>{data.manager.name}</strong></span><span>{zh ? "销售负责人" : "Sales owner"}<strong>{data.sales.name}</strong></span><span>{zh ? "统计范围" : "Scope"}<strong>{zh ? `${data.groups.length} 个视频 · ${chart.total} 项有效语言任务` : `${data.groups.length} videos · ${chart.total} active language tasks`}</strong></span></div>
    <div className="psm-chart-grid">
      <figure className="psm-completion-chart">
        <figcaption><h3>{zh ? "项目整体完成度" : "Overall project completion"}</h3><p>{zh ? "外环：质检通过 · 内环：交付完成" : "Outer ring: quality approved · Inner ring: delivered"}</p></figcaption>
        <div className="psm-donut">
          <svg viewBox="0 0 280 280" role="img" aria-label={zh ? `质检通过 ${chart.productionPercent}%，交付完成 ${chart.deliveryPercent}%` : `Quality approved ${chart.productionPercent}%, delivered ${chart.deliveryPercent}%`}>
            <circle className="psm-ring-track" cx="140" cy="140" r="112" strokeWidth="20" />
            <circle className="psm-ring-production" cx="140" cy="140" r="112" strokeWidth="20" pathLength="100" strokeDasharray={`${chart.productionPercent} 100`} transform="rotate(-90 140 140)" />
            <circle className="psm-ring-track" cx="140" cy="140" r="89" strokeWidth="10" />
            <circle className="psm-ring-delivery" cx="140" cy="140" r="89" strokeWidth="10" pathLength="100" strokeDasharray={`${chart.deliveryPercent} 100`} transform="rotate(-90 140 140)" />
          </svg>
          <div className="psm-donut-label"><strong>{chart.total ? `${chart.productionPercent}%` : "—"}</strong><span>{productionLabel}</span><small>{chart.approved} / {chart.total} {zh ? "项任务" : "tasks"}</small></div>
        </div>
        <div className="psm-ring-key">
          <div><span><i className="production" />{productionLabel}</span><strong>{chart.approved} / {chart.total}</strong><small>{zh ? "已质检通过" : "Quality approved"}</small></div>
          <div><span><i className="delivery" />{deliveryLabel}</span><strong>{chart.total ? `${chart.deliveryPercent}%` : "—"}</strong><small>{chart.delivered} / {chart.total} {zh ? "项已交付" : "tasks delivered"}</small></div>
        </div>
      </figure>
      <figure className="psm-distribution-chart">
        <figcaption><h3>{zh ? "任务阶段分布" : "Task stage distribution"}</h3><p>{zh ? "各阶段语言任务占比 · 点击柱条查看任务" : "Share of language tasks by stage · Select a bar for tasks"}</p></figcaption>
        <div className="psm-distribution-axis" aria-hidden="true"><span>0</span><span>25%</span><span>50%</span><span>75%</span><span>100%</span></div>
        <div className="psm-distribution-bars">{series.map(item => <button key={item.id} className="psm-distribution-row" type="button" onClick={() => onStage(item.id)} aria-label={`${item.label}: ${item.count} / ${chart.total}`}>
          <span className="psm-bar-label">{item.label}</span><span className="psm-bar-track" aria-hidden="true"><i data-stage={item.id} style={{ width: `${chart.total ? item.count / chart.total * 100 : 0}%` }} /></span><strong>{item.count}<small>{zh ? " 项" : " tasks"}</small></strong>
        </button>)}</div>
        {chart.terminated > 0 && <button type="button" className="psm-excluded link-button" onClick={() => onStage("terminated")}>{zh ? `${chart.terminated} 项已终止，未计入完成率 →` : `${chart.terminated} terminated tasks excluded from completion →`}</button>}
      </figure>
    </div>
    <p className="psm-note">{zh ? "质检通过率和交付率按语言任务等权统计，与剪辑师填报的制作进度分别显示，不估算工时。" : "Quality approval and delivery rates give equal weight to language tasks. Editor-reported production progress is separate and does not estimate working hours."}{chart.unplannedVideos > 0 ? (zh ? ` 另有 ${chart.unplannedVideos} 个视频尚未拆分语言任务，未计入完成率。` : ` ${chart.unplannedVideos} videos have no language tasks yet and are not included.`) : ""}</p>
    <figure className="psm-video-chart">
      <figcaption><div><h3>{zh ? "各视频进度对比" : "Progress by video"}</h3><p>{zh ? "每根柱条代表一个视频，色块表示各阶段的任务比例" : "Each bar is one video; segments show the share of tasks at each stage"}</p></div><span>{zh ? "点击视频查看任务明细" : "Select a video for task details"}</span></figcaption>
      <div className="psm-chart-legend">{series.map(item => <span key={item.id}><i data-stage={item.id} />{item.label}</span>)}</div>
      <div className="psm-video-chart-axis" aria-hidden="true"><span>0</span><span>25%</span><span>50%</span><span>75%</span><span>100%</span></div>
      <div className="psm-video-chart-rows">{chart.videos.map(video => {
        const roles = { sales: zh ? "销售跟进" : "Sales follow-up", manager: zh ? "项目跟进" : "PM follow-up", editor: zh ? "当前剪辑" : "Current editor", reviewer: zh ? "当前质检" : "Current reviewer" };
        const ownerGroups = Object.entries(roles).map(([role, label]) => ({ label, names: [...new Map(video.rows.filter(row => row.role === role).map(row => [row.owner.email, row.owner.name])).values()].join(zh ? "、" : ", ") }));
        const segments = series.map(item => ({ ...item, count: video.rows.filter(row => row.exception === item.id || (!row.exception && row.stage === item.id)).length })).filter(item => item.count);
        return <div className="psm-video-chart-row" key={video.id} data-video-id={video.id}>
          <button type="button" className="psm-video-chart-name" onClick={() => onVideo(video.id)}><strong>{video.name}</strong><span>{video.total} {zh ? "项有效语言任务" : "active language tasks"}</span></button>
          <div className="psm-video-chart-main">
            <div className="psm-stacked-bar" role="img" aria-label={`${video.name}: ${segments.map(item => `${item.label} ${item.count}`).join(", ") || (zh ? "无有效任务" : "No active tasks")}`}>
              {segments.map(item => <i key={item.id} data-stage={item.id} style={{ width: `${video.total ? item.count / video.total * 100 : 0}%` }} title={`${item.label}: ${item.count}`} />)}
              {!video.total && <span>{video.terminated ? (zh ? "全部已终止" : "All tasks terminated") : (zh ? "尚未创建语言任务" : "No language tasks yet")}</span>}
            </div>
            <div className="psm-video-owners">{ownerGroups.filter(group => group.names).map(group => <span key={group.label}>{group.label}<b>{group.names}</b></span>)}</div>
            <div className="psm-reported-progress">{video.rows.map(row => <ReportedTaskProgress key={row.id} task={row.task} locale={locale} />)}</div>
          </div>
          <div className="psm-video-chart-value"><strong>{video.total ? `${video.productionPercent}%` : "—"}</strong><span>{productionLabel}</span><small>{zh ? `交付 ${video.delivered}/${video.total}` : `Delivered ${video.delivered}/${video.total}`}</small>{video.terminated > 0 && <small>{video.terminated} {zh ? "项已终止" : "terminated"}</small>}</div>
        </div>;
      })}</div>
      {!chart.videos.length && <p className="psm-empty">{zh ? "尚未创建视频任务，创建后将在图表中显示。" : "Create video tasks to see their progress here."}</p>}
    </figure>
  </>;
}

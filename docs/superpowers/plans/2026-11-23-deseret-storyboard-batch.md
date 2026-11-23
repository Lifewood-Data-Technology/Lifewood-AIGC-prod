# Deseret storyboard drafts and internal review

## Workflow / 制作流程

The editor can save one scene today and add more in later sessions. Each draft identifies a scene, a durable video version, and its duration. On confirmation, the current task’s drafts enter internal QC together. The reviewer decides each submitted version separately. A rejected scene can receive a replacement while the other approved videos keep their decisions. The lead can publish once all current scenes have passed and no outstanding drafts remain.

制作人员可分次保存任意数量的分镜，沿用每个审阅包最多 200 个分镜的既有上限。草稿保存视频版本与时长。确认送审时，当前语言任务的草稿一起进入质检。质检员逐镜审核，被退回的分镜可单独重交。项目仍有草稿或未通过的分镜时，负责人不能发布分镜给出版社。

## Implementation and local acceptance / 实施与本地验收

1. Store drafts in the linked project's current state, guarded by task ownership and revision. Verify refresh, cross-task isolation and stale writes.
2. Promote each confirmed video to its own QC version in one guarded transaction. Verify submission retries and one notification for a batch.
3. Review exact scene versions in the reviewer workspace. Verify mixed decisions, replacing a rejected video, and approval persistence.
4. Check the lead's publication gate and run the existing regression suite, including assembled finals and legacy data.

1. 在项目关联记录保存草稿，并校验任务归属和版本。验证刷新、任务隔离与并发修改。
2. 一次提交为各分镜分别登记待质检版本。验证重试以及同批只通知一次。
3. 在质检工作台逐个审核指定版本。验证部分通过、部分退回及单镜重交。
4. 验证负责人的发布条件，回归既有成片和历史项目流程。

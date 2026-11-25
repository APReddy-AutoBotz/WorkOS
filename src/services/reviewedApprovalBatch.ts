import { ApiClientError } from './apiClient';
import { approvalUuid } from '../../shared/work-approval.mjs';
import { workApprovals, isWorkApprovalContextCurrent, type WorkApprovalContext, type WorkApprovalPage, type WorkDecisionReceipt } from './workApprovals';
import type { AssignmentApprovalPage, AssignmentCreationPage } from './assignmentApprovals';
import type { LeaveApprovalPage } from './leaveApprovals';

export type ReviewKind = 'Work' | 'Material' | 'Creation' | 'Leave';
export type ApprovalPage = WorkApprovalPage | AssignmentApprovalPage | AssignmentCreationPage | LeaveApprovalPage;
export type ReviewedApproval = Readonly<{ kind: ReviewKind; page: ApprovalPage; decision: 'Approved' | 'Rejected'; reason: string; requestId: string }>;
export type BulkContexts = { work: WorkApprovalContext | null; assignment: WorkApprovalContext | null; leave?: WorkApprovalContext | null };
export type ItemResult = { requestId: string; status: 'Confirmed' | 'Denied' | 'Uncertain' | 'NotAttempted'; receipt?: WorkDecisionReceipt; httpStatus?: number };
export const reviewReadMode = (kind: ReviewKind): WorkApprovalContext['mode'] => kind === 'Work' ? 'read' : kind === 'Leave' ? 'leave' : 'assignment';
const freeze = <T,>(v: T): T => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
export const reviewApproval = (kind: ReviewKind, page: ApprovalPage, decision: 'Approved' | 'Rejected', reason: string, requestId = crypto.randomUUID()): ReviewedApproval => {
  if (!['Work', 'Material', 'Creation', 'Leave'].includes(kind) || !approvalUuid(requestId) || !['Approved', 'Rejected'].includes(decision) || !reason.trim() || reason.trim().length > 1000 || page.instance.state.status !== 'Pending' || (kind === 'Work') !== ('timesheetId' in page.instance) || (kind === 'Creation') !== ('operationKind' in page.instance) || (kind === 'Leave') !== ('currentSource' in page.instance) || kind === 'Leave' && (!(page as LeaveApprovalPage).instance.current || (page as LeaveApprovalPage).instance.currentStatus !== 'Submitted' || Boolean((page as LeaveApprovalPage).instance.cancelled))) throw new Error('Inspect a pending source and choose its decision and reason.');
  return freeze(JSON.parse(JSON.stringify({ kind, page, decision, reason: reason.trim(), requestId })) as ReviewedApproval);
};
const context = (item: ReviewedApproval, c: BulkContexts) => item.kind === 'Work' ? c.work : item.kind === 'Leave' ? c.leave : c.assignment;
const current = (c: BulkContexts) => Boolean((c.work || c.assignment || c.leave) && [c.work, c.assignment, c.leave].every(v => !v || isWorkApprovalContextCurrent(v)));
export const executeReviewedApprovals = async (items: readonly ReviewedApproval[], c: BulkContexts, live: () => boolean, report: (r: ItemResult) => void, uncertainBefore: ReadonlySet<string> = new Set()) => {
  if (!items.length || items.length > 20 || new Set(items.map(i => i.kind + ':' + i.page.instance.id)).size !== items.length || new Set(items.map(i => i.requestId)).size !== items.length) throw new Error('Choose one to twenty distinct reviewed sources.');
  let stopped = false;
  for (const item of items) {
    if (stopped || !live() || !current(c)) { report({ requestId: item.requestId, status: uncertainBefore.has(item.requestId) ? 'Uncertain' : 'NotAttempted' }); stopped = true; continue; }
    const ctx = context(item, c);
    if (!ctx) { const unresolved = uncertainBefore.has(item.requestId); report({ requestId: item.requestId, status: unresolved ? 'Uncertain' : 'Denied', httpStatus: 403 }); if (unresolved) stopped = true; continue; }
    try {
      const out = item.kind === 'Work'
        ? await workApprovals.decide(item.page as WorkApprovalPage, item.decision, item.reason, item.requestId, ctx)
        : item.kind === 'Leave'
        ? await workApprovals.leave.decide(item.page as LeaveApprovalPage, item.decision, item.reason, item.requestId, ctx)
        : await workApprovals.assignments.decide(item.page as AssignmentApprovalPage | AssignmentCreationPage, item.decision, item.reason, item.requestId, ctx);
      if (!live() || !current(c)) { report({ requestId: item.requestId, status: 'Uncertain' }); stopped = true; }
      else report({ requestId: item.requestId, status: 'Confirmed', receipt: out.receipt });
    } catch (error) {
      const status = error instanceof ApiClientError ? error.status : undefined;
      // A definitive retry refusal describes only that attempt. It cannot
      // establish whether the original uncertain request committed.
      const definitive = !uncertainBefore.has(item.requestId) && live() && current(c) && status !== undefined && [400, 403, 404, 409, 422].includes(status);
      report({ requestId: item.requestId, status: definitive ? 'Denied' : 'Uncertain', httpStatus: status });
      if (!definitive) stopped = true;
    }
  }
};
export const inspectApproval = async (kind: ReviewKind, id: string, c: WorkApprovalContext | null): Promise<ApprovalPage> => kind === 'Work' ? workApprovals.instance(id, c) : kind === 'Leave' ? workApprovals.leave.instance(id, c) : kind === 'Creation' ? workApprovals.assignments.creation(id, c) : workApprovals.assignments.instance(id, c);
export const reconcileReviewedApproval = async (item: ReviewedApproval, c: WorkApprovalContext | null) => {
  const page = await inspectApproval(item.kind, item.page.instance.id, c), before = item.page.instance, now = page.instance;
  if (page.ownerKey !== item.page.ownerKey || page.actorUserId !== item.page.actorUserId || now.sourceToken !== before.sourceToken) throw new Error('Reviewed owner or source does not match.');
  const found = now.transitions.find(t => t.requestId === item.requestId);
  if (found) {
    const stages = item.kind === 'Work' ? (item.page as WorkApprovalPage).instance.policy.stages : (item.page as AssignmentApprovalPage | LeaveApprovalPage).instance.policy.definition.stages;
    if (found.actorId !== page.actorUserId || found.activeRole !== stages[before.state.currentStage!].role || found.decision !== item.decision || found.reason !== item.reason || found.stage !== before.state.currentStage || found.sequence !== before.state.sequence + 1) throw new Error('Retained decision does not match the reviewed request.');
    return { status: 'Confirmed' as const, receipt: found };
  }
  const sameStage = now.state.status === 'Pending' && now.state.sequence === before.state.sequence && now.state.currentStage === before.state.currentStage;
  const sameSource = item.kind === 'Work' ? Boolean((now as WorkApprovalPage['instance']).source?.isCurrentSubmission && (now as WorkApprovalPage['instance']).source?.currentHeaderStatus === 'Submitted') : item.kind === 'Leave' ? Boolean((now as LeaveApprovalPage['instance']).current && (now as LeaveApprovalPage['instance']).currentStatus === 'Submitted' && !(now as LeaveApprovalPage['instance']).cancelled && (now as LeaveApprovalPage['instance']).revision === (before as LeaveApprovalPage['instance']).revision) : (now as AssignmentApprovalPage['instance']).currentRevision === (before as AssignmentApprovalPage['instance']).sourceRevision && (now as AssignmentApprovalPage['instance']).currentVersionId === (before as AssignmentApprovalPage['instance']).sourceVersionId;
  return { status: sameStage && sameSource ? 'Unresolved' as const : 'Changed' as const };
};

import type {commercialDraftingService} from '../services/commercialDrafting';

type Policy=Awaited<ReturnType<typeof commercialDraftingService.riskNoticePolicy>>['latest'];

export function RiskNoticePolicyFields({policy,today}:{policy:Policy;today:string}) {
  return <>
      <label>Effective from <input type="date" name="date" min={today.slice(0,10)} required defaultValue={policy && policy.effectiveFrom>today.slice(0,10)?policy.effectiveFrom:today.slice(0,10)}/></label>
      <label>Commercial manager user ID <input name="manager" required defaultValue={policy?.manager.userId}/></label>
      <label>Commercial manager role <input name="managerRole" required defaultValue={policy?.manager.role}/></label>
      <label>Finance or billing owner user ID <input name="finance" required defaultValue={policy?.finance.userId}/></label>
      <label>Finance or billing owner role <input name="financeRole" required defaultValue={policy?.finance.role}/></label>
      <label>Template locale <input name="locale" required defaultValue={policy?.locale} placeholder="en-GB"/></label>
      <label>Notification title <input name="title" maxLength={200} required defaultValue={policy?.title}/></label>
      <label>Notification body <textarea name="body" maxLength={2000} required defaultValue={policy?.body}/></label>
      <label>Reason for change <input name="reason" minLength={3} maxLength={1000} required/></label>
  </>;
}

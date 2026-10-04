import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CheckCircle2, ExternalLink, ShieldCheck } from 'lucide-react';
import { PageHeader } from '../components/ui/PageHeader';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { integrationService } from '../services/api';
import type { TeamsActionToken } from '../types';

import { productConfig } from '../config/productConfig';
export const TeamsActionLanding = () => {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<TeamsActionToken | null>(null);
  const [error, setError] = useState('');

  const tokenPreview = useMemo(() => token ? `${token.slice(0, 8)}...${token.slice(-6)}` : '', [token]);

  const execute = async () => {
    if (!token || executing) return;
    setExecuting(true);
    setError('');
    try {
      const next = await integrationService.executeTeamsActionToken(token, `Completed from ${productConfig.productName} Teams action link.`);
      setResult(next);
      if (next.action === 'open_portal' && next.targetUrl) {
        navigate(next.targetUrl);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Teams action could not be executed.');
    } finally {
      setExecuting(false);
    }
  };

  return (
    <div className="space-y-6 pb-12">
      <PageHeader
        title="Teams Action"
        subtitle={`Secure deterministic action handoff from Microsoft Teams into ${productConfig.productName}.`}
        breadcrumb={['Workforce OS', 'Integrations', 'Teams Action']}
      />

      <Card>
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="info">Single-use</Badge>
              <Badge variant="warning">Expires automatically</Badge>
              <Badge variant="success">Role scoped</Badge>
            </div>
            <h2 className="mt-4 text-xl font-black text-heading">Review and execute this Teams action</h2>
            <p className="mt-2 max-w-2xl text-sm font-medium leading-relaxed text-body/70">{`
              This link must be opened by an authenticated ${productConfig.productName} user. The backend validates the token, expiry,
              active role, data scope, and required permissions before any approval or portal action is completed.
            `}</p>
            {tokenPreview && <p className="mt-4 text-xs font-black uppercase tracking-widest text-slate-400">Token {tokenPreview}</p>}
          </div>
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-orange-50 text-primary">
            <ShieldCheck size={24} />
          </div>
        </div>

        {error && <div className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-bold text-red-700">{error}</div>}
        {result && (
          <div className="mt-5 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm font-bold text-green-700">
            <div className="flex items-center gap-2"><CheckCircle2 size={16} /> Teams action completed: {result.action}</div>
          </div>
        )}

        <div className="mt-6 flex flex-wrap gap-3">
          <button type="button" onClick={execute} disabled={!token || executing || Boolean(result?.usedAt)} className="btn-primary flex items-center gap-2 px-5 py-2.5 text-sm disabled:opacity-50">
            <CheckCircle2 size={16} /> {executing ? 'Executing...' : 'Execute Action'}
          </button>
          <Link to="/approvals" className="btn-secondary flex items-center gap-2 px-5 py-2.5 text-sm">
            <ExternalLink size={16} /> Open Approvals
          </Link>
        </div>
      </Card>
    </div>
  );
};

import { Download, FileText } from 'lucide-react';
import { useState } from 'react';
import { PageHeader } from '../components/ui/PageHeader';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { cn } from '../lib/utils';
import { downloadReportExport, getReportExportOptions } from '../lib/reportExport';

export const ReportsCenter = () => {
  const reportExportOptions = getReportExportOptions();
  const [downloading, setDownloading] = useState<string | null>(null);
  const [notice, setNotice] = useState<string>('');

  const handleDownload = async (id: string) => {
    setDownloading(id);
    setNotice('');
    try {
      await downloadReportExport(id);
      setNotice('Report export started and audit history was updated.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Report export could not be completed.');
    } finally {
      setDownloading(null);
    }
  };

  return (
    <div className="space-y-6 pb-12">
      <PageHeader
        title="Reports Center"
        subtitle="Download operational, planning, delivery, time, and governance reports from one controlled location."
        breadcrumb={['Reports', 'Downloads']}
      />

      {notice && (
        <div className="rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 text-sm font-bold text-blue-700">
          {notice}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {reportExportOptions.map(option => (
          <div key={option.id}>
            <Card className="p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-4">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-orange-50 text-primary">
                    <FileText size={20} />
                  </div>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-sm font-black text-heading">{option.title}</h2>
                      <Badge variant="neutral">{option.category}</Badge>
                    </div>
                    <p className="mt-2 text-sm font-medium leading-relaxed text-body/70">{option.description}</p>
                    <p className="mt-2 text-[10px] font-black uppercase tracking-widest text-slate-400">{option.fileName}</p>
                  </div>
                </div>
                <button
                  onClick={() => handleDownload(option.id)}
                  disabled={downloading === option.id}
                  className={cn('btn-primary flex shrink-0 items-center gap-2 px-4 py-2 text-xs', downloading === option.id && 'opacity-60')}
                >
                  <Download size={15} />
                  CSV
                </button>
              </div>
            </Card>
          </div>
        ))}
      </div>
    </div>
  );
};

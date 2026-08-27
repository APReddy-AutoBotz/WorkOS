import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { authService } from '../services/authService';

import { productConfig } from '../config/productConfig';
export const EntraLoginComplete = () => {
  const navigate = useNavigate();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    authService.completeEntraLogin().then(session => {
      if (!active) return;
      if (session) {
        navigate('/', { replace: true });
      } else {
        setFailed(true);
      }
    });
    return () => {
      active = false;
    };
  }, [navigate]);

  if (failed) return <Navigate to="/login?error=entra_session_failed" replace />;

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-secondary px-6">
      <div className="rounded-3xl border border-border-light bg-white p-8 text-center shadow-xl">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-orange-50 text-primary">
          <ShieldCheck size={24} />
        </div>
        <h1 className="mt-5 text-xl font-black text-heading">Completing Microsoft Entra sign-in</h1>
        <p className="mt-2 text-sm font-medium text-body/60">{`Validating your ${productConfig.productName} session.`}</p>
      </div>
    </div>
  );
};

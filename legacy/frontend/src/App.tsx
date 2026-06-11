import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Layout } from '@/components/layout/Layout';
import { Dashboard } from '@/pages/Dashboard';
import { Accounts } from '@/pages/Accounts';
import { Transactions } from '@/pages/Transactions';
import { CreditCards } from '@/pages/CreditCards';
import { Planning } from '@/pages/Planning';
import { Reports } from '@/pages/Reports';
import { Goals } from '@/pages/Goals';
import { Categories } from '@/pages/Categories';
import { Tags } from '@/pages/Tags';
import { Calendar } from '@/pages/Calendar';
import { Performance } from '@/pages/Performance';
import { Import } from '@/pages/Import';
import { Settings } from '@/pages/Settings';

const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: 1 } } });

export default function App() {
  return (
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <div className="dark">
          <Routes>
            <Route element={<Layout />}>
              <Route path="/" element={<Dashboard />} />
              <Route path="/accounts" element={<Accounts />} />
              <Route path="/transactions" element={<Transactions />} />
              <Route path="/credit-cards" element={<CreditCards />} />
              <Route path="/planning" element={<Planning />} />
              <Route path="/reports" element={<Reports />} />
              <Route path="/goals" element={<Goals />} />
              <Route path="/categories" element={<Categories />} />
              <Route path="/tags" element={<Tags />} />
              <Route path="/calendar" element={<Calendar />} />
              <Route path="/performance" element={<Performance />} />
              <Route path="/import" element={<Import />} />
              <Route path="/settings" element={<Settings />} />
            </Route>
          </Routes>
        </div>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

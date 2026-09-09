import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { SignupView } from './views/SignupView';
import { PrivacyView } from './views/PrivacyView';
import './index.css';

// A client-side Back/Link to the app must pass through its own bootstrap.
function ReloadEntry() {
  useEffect(() => {
    window.location.reload();
  }, []);
  return <a href="/">Open Carbon</a>;
}
createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <Routes>
      <Route path="/signup" element={<SignupView />} />
      <Route path="/privacy" element={<PrivacyView />} />
      <Route path="*" element={<ReloadEntry />} />
    </Routes>
  </BrowserRouter>,
);

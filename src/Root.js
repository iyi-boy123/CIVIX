import React, { useState, useEffect } from "react";
import App from "./App";
import AdminDashboard from "./AdminDashboard";

/* Picks which app to show from the URL:
   any path starting with "/admin" -> the admin dashboard
   everything else                 -> the main CIVIX app            */
export default function Root() {
  const [path, setPath] = useState(window.location.pathname);

  // Keeps working if the URL changes without a full page load (back/forward buttons).
  useEffect(() => {
    const onChange = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onChange);
    return () => window.removeEventListener("popstate", onChange);
  }, []);

  return path.startsWith("/admin") ? <AdminDashboard /> : <App />;
}

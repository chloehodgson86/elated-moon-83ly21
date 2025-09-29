// src/supabaseClient.js
import { createClient } from "@supabase/supabase-js";

// Create a single supabase client for the whole app
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

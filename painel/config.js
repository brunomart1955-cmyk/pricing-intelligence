// Configuração do Supabase (Project Settings → API).
// A "anon public key" é feita para ficar no navegador: quem protege os dados
// são as regras de segurança (RLS) do arquivo supabase.sql.
// NUNCA coloque aqui a "service_role key".
window.SR_CONFIG = {
  supabaseUrl: '',      // ex.: 'https://abcdxyz.supabase.co'
  supabaseAnonKey: ''   // ex.: 'eyJhbGciOiJIUzI1NiIs...'
};

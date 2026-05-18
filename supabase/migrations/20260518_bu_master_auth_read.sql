-- Allow authenticated users to read bu_master (previously only anon role had SELECT)
create policy "authenticated_read" on bu_master for select to authenticated using (true);

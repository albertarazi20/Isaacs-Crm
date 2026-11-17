-- The {missing_docs} merge field (src/lib/mca/stips.ts missingDocsPhrase): the shop's checklist emails name exactly
-- what the merchant still owes ("your September bank statement and a voided check") instead of a generic ask.
-- Only the stock wording is changed: replace() leaves a template the shop has rewritten exactly as it is.

update templates
   set body = replace(body, 'I am still missing bank statements for {business}.',
                            'I am still missing {missing_docs} for {business}.'),
       updated_at = now()
 where owner_id is null and name = 'Statements — second ask'
   and body like '%I am still missing bank statements for {business}.%';

update templates
   set body = replace(body, 'Two quick items to close the file for {business}: a photo of your driver''s license and a voided check.',
                            'To close the file for {business} I only need {missing_docs}.'),
       subject = case when subject = 'Two small items for {business}' then 'One last step for {business}' else subject end,
       updated_at = now()
 where owner_id is null and name = 'ID and voided check'
   and body like '%Two quick items to close the file for {business}: a photo of your driver''s license and a voided check.%';

update templates
   set body = replace(body, 'lenders will ask for your newest bank statement before they approve {business}.',
                            'lenders will ask for {missing_docs} before they approve {business}.'),
       updated_at = now()
 where owner_id is null and name = 'Newest statement'
   and body like '%lenders will ask for your newest bank statement before they approve {business}.%';

-- Himachal festivals and events as EDITABLE PLACEHOLDERS.
-- Every row is status 'draft'. Dates are approximate typical windows for the next
-- occurrence; most follow the lunar calendar or a government schedule and shift
-- each year. Confirm dates, then edit and publish from the admin events API
-- (PATCH /api/admin/events/:id with {"status":"published"}). Nothing here shows
-- on the public site until published.
-- Needs the events table (migrations). Safe to re-run: existing slugs are kept.
-- To undo: delete from events where starts_with(description, '[Placeholder]');
begin;
insert into events (slug, title, description, town, district, starts_on, ends_on, status) values
('lohri-bonfire-nights-2027',
 'Lohri bonfire nights',
 '[Placeholder] Lohri marks the winter harvest with bonfires, folk songs and sweets across Himachal. Celebrated on 13 January each year. Check with your host for the neighbourhood bonfire.',
 'Dharamshala', 'Kangra', '2027-01-13', '2027-01-13', 'draft'),
('manali-winter-carnival-2027',
 'Manali Winter Carnival',
 '[Placeholder] A multi-day winter festival of folk dance, music, a fashion show and food stalls in and around Manali. The dates are set by the district administration each year and usually fall in January.',
 'Old Manali', 'Kullu', '2027-01-16', '2027-01-20', 'draft'),
('losar-celebrations-mcleod-ganj-2027',
 'Losar, Tibetan New Year',
 '[Placeholder] Losar is the Tibetan New Year, marked with prayers, butter lamps, cham dances and festive meals in the Tibetan community around McLeod Ganj and Dharamshala. It follows the Tibetan lunar calendar, usually February or March.',
 'Dharamshala', 'Kangra', '2027-02-07', '2027-02-09', 'draft'),
('minjar-fair-chamba-2027',
 'Minjar Fair',
 '[Placeholder] A week-long fair in Chamba town at the Chaugan, with a procession, folk music and dance, and the offering of minjar (maize tassels) to the Ravi river. It is held in the Shravan month, usually July or August.',
 'Chamba', 'Chamba', '2027-08-01', '2027-08-08', 'draft'),
('bir-billing-paragliding-season-2027',
 'Bir Billing paragliding season',
 '[Placeholder] Bir is one of the best-known paragliding launch sites in India. The main flying seasons are roughly March to June and September to November, weather permitting. Dates for the Paragliding World Cup or Pre-World Cup, when held, are announced separately.',
 'Bir', 'Kangra', '2027-03-01', '2027-06-15', 'draft'),
('kullu-dussehra-2027',
 'Kullu Dussehra',
 '[Placeholder] A week-long festival at the Dhalpur maidan in Kullu, starting on Vijayadashami, where hill deities arrive in procession on palanquins. The start date follows the lunar calendar and falls in October.',
 'Kullu', 'Kullu', '2027-10-09', '2027-10-15', 'draft'),
('dharamshala-international-film-festival-2027',
 'Dharamshala International Film Festival',
 '[Placeholder] An independent film festival with screenings, filmmaker conversations and workshops in Dharamshala and McLeod Ganj. It is usually held in autumn, often late October or early November.',
 'Dharamshala', 'Kangra', '2027-10-28', '2027-10-31', 'draft')
on conflict (slug) do nothing;
commit;

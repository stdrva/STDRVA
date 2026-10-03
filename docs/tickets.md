docs/tickets.md

Format: BF-YYWW-NNN for bugs and FF-YYWW-NNN for features. Year then ISO week of the Eastern report day. The last three digits only go up. Never reuse. Never use 001 again. Features use FF- names. Bugs use BF- names. Next unused BF- name: BF-2640-086. Next unused FF- name: FF-2640-026. Do not reuse BF-2640-073.

Lessons are L1 L2 L3 L4. Old FF-3926-* names in CHANGELOG.md are history.

Always write the full ticket name.

Live BOS is BOS 1.8.1 commit f5f75d9. Render auto-deploy is off.

Open

BF-2640-073 Retired. This was an Architect checklist problem. This is not a BOS job. Do not reuse this name.

BF-2640-074 Handbook. We want start.md and docs/tickets.md on GitHub. Claude Code copies the Architect exact files. Claude Code does not rewrite them.

Finished in BOS 1.8.6

FF-2640-025 is committed and pushed to main in BOS 1.8.6. Live BOS gets it after Andrew runs Manual Deploy of main on Render.

FF-2640-025 Five questions on the two design consultations. Now the five optional questions sit on Callback by Owner and More Info by Email, and the booked page asks them after any appointment. Short Design Consultation does not ask them on the booking page. We do not want that. Short Design Consultation and Long Design Consultation show the five questions on the booking page, before the visit is booked. The questions stay optional. The same five questions are the five-question form. That form is not a person. Callback by Owner does not show that form. More Info by Email does not show that form. Design Review does not show that form. Repair or Warranty does not show that form. No other visit type shows that form. The booked page does not ask the five questions again.

The five questions are the questions BOS already asks. Question 1 asks where the customer wants a change, and the choices are Kitchen, Bathroom(s), Garage, Shop, Studio, Commercial, Hidden kick-panel, and Closet. Question 2 asks if the customer has pets, and a yes asks if a treat is ok and asks the pet name and breed. Question 3 asks if the customer has had pull-out shelves before, and a yes asks what they liked and what they did not like. Question 4 asks which products to show, using the product list BOS already has. Question 5 asks if there is anything else Andrew should know. Claude Code does not invent new questions.

Finished in BOS 1.8.5

These tickets are committed and pushed to main in BOS 1.8.5. Live BOS gets them after Andrew runs Manual Deploy of main on Render.

BF-2640-085 Tomorrow page. Now Tomorrow opens a list that says Tomorrow, then Open tomorrow's day page opens a day page that says Today. We do not want that list. The button Tomorrow on Today opens the day page for the next day. The heading and the title say Tomorrow when the date is tomorrow. A day that is not today and not tomorrow says the date. Back to today stays. The visit list does not get a second screen in front of it. The day page must show the visits BOS already stored for that date. A visit that exists only on the phone calendar is not in BOS.

FF-2640-024 Today on the phone bar. Now the phone bottom bar is Back, Overview, Appts, Pipeline, and Menu. We want Today in the Pipeline spot. The bar is Back, Overview, Appts, Today, and Menu. Pipeline stays in the Menu. Today opens the day page.

FF-2640-021 One file name. Now BOS keeps a machine id in the uploads folder and a different name on the Files page. We want one readable name on new files. The folder is the customer last name. A second customer with the same last name is Walker-2. The file name is the thing plus the year and week, as in contract-2640.pdf. October 2, 2026 is week 40, so the week part is 2640. Do not put a first name in the name. Do not add a customer number in this upload. The same name is the name on the Files page and the name in the folder. A rename on the Files page renames the file. Search still uses that name, the note, and the words already read out of the file. Old files stay as they are. Do not rename files already stored. When BOS will not start, we want that same folder and those same file names, plus customer.txt with the name, the phone, the email, the address, and the note.

FF-2640-022 Company documents. We want a Documents item in the Menu near the end, above the version line and Log out. The shelf holds the warranty certificate, product pages, handwritten referrals, insurance, the business license, and product photos. The first insurance file is the certificate of liability, policy Q51-0725519, and the umbrella policy Q34-0270524, effective 10/02/2026 through 10/02/2027. Warranty in the email box attaches the warranty certificate. Andrew can upload a product photo from the email box and tick that photo, and the description goes with the photo. Andrew can attach any document on this shelf the same way Andrew ticks a file. Andrew still confirms before send. If the warranty PDF is not in the repo, Claude Code asks Andrew for the file. Claude Code does not invent a new certificate. Claude Code note: the certificate Andrew has shows the general liability policy as Q61-0725519, so BOS uses Q61-0725519. The warranty PDF is not in the repo, and Claude Code asked Andrew for the file.

FF-2640-023 Personal vault. We want a vault for Andrew only. A login row holds the site name, the URL, the username, the password, and a note. Build the Clerk's Information System row. The site is https://cis.scc.virginia.gov/. The username is andrewkerwin. The email is andrew2481@aol.com. The password is blank. The note is kept only in the vault and is not written here. The password does not go in GitHub.

Finished in BOS 1.8.4

These tickets are committed and pushed to main in BOS 1.8.4. Live BOS gets them after Andrew runs Manual Deploy of main on Render.

BF-2640-083 day boundary. Now a new calendar date at midnight starts a new routine day, so Andrew checking an evening item after midnight checks the next day. We want the routine day to run until 5:00 AM Eastern. From midnight until 5:00 AM, Today still shows the day that just ended. Morning checks already made stay on that date. Evening checks before 5:00 AM stay on that date. At 5:00 AM the new date starts unchecked.

BF-2640-084 Missing controls and signature placement. Now Delete and Sign have been disappearing from BOS screens. Files are not vanishing from disk. We want the Delete control back on the file Andrew is viewing, and that Delete is a soft delete Andrew can restore from Deleted Files. We want Sign back. Andrew locked the placement. On the sales contract, put the signature in the signature box. On the drawing, put the signature near the edge of the page. Do not invent a different spot. Do not remove a control that is already on the page.

FF-2640-015 Tomorrow. Now Today shows this date only. We want a button on Today that opens tomorrow's visits from appointments BOS already stored. Tomorrow follows the same 5:00 AM Eastern day boundary.

FF-2640-016 Contacts. Now the Menu says Desk. Andrew does not want that word. We want the Menu label, the page heading, and Foreman to say Contacts. A contact is something Andrew can contact. A contact does not have to have a name and a phone and an address and an email. We want marks on a contact: business lead or customer, personal contact, vendor or supplier, and more than one mark is allowed. We want the Contacts page to filter by those marks. Keep old /dashboard/desk links working. A car is not a contact.

FF-2640-017 Files. We want Foreman and BOS to move a file, rename a file, copy a file, and soft-delete a file. When a new file has the same name as a different file already stored, flag the clash and change the new name slightly. Do not silently overwrite.

FF-2640-018 Booking source. Now public booking creates a customer and does not write a marketing source, except Home Show. We want the book form to ask how they heard, using marketing sources BOS already has, and we want that choice written as the first attribution on that customer.

FF-2640-019 Calendar invite. Now a scheduled visit does not send a calendar invite. We want an invite email to the customer and an invite email to Andrew after BOS writes a scheduled visit, using the email path BOS already has. If BOS has no invite attachment yet, add a simple .ics file. Do not connect iCloud.

FF-2640-020 Lists. We want a grocery list, a project list, and a vehicle list Andrew can add a row to. A vehicle is not a contact. Do not rebuild bookkeeping. Budget stays the bookkeeping Andrew already has.

Finished in BOS 1.8.3

BF-2640-083 is committed and pushed to main in BOS 1.8.3. Live BOS gets it after Andrew runs Manual Deploy of main on Render.

BF-2640-083 Command center day page. Andrew wants a day page Andrew can use tomorrow morning. Today shows visits already booked, plus small items Andrew pulled onto that day. Unsorted items sit until Andrew picks them onto a day. A call does not jump onto the morning list by itself. An overdue item can show in red. Andrew can change the due date. ABC 123 can sort an item. A is must-do, B is should-do, C is could-do, and the number is the order inside that letter. Morning and evening are checklists Andrew built. Take meds is on the morning list. Andrew checks a routine item off for that day. Routine checks reset at the end of the day, which means a new date starts unchecked. Store the check on the date so Thursday can still show that Thursday's meds were checked. Foreman can add an item, check an item, read today, and add a write-in to the routine list.

Finished on main after BOS 1.8.2

These tickets are committed and pushed to main at commit 755b134. Live BOS gets them after Andrew runs Manual Deploy of main on Render.

BF-2640-070 Voice. Now the Voice screen can say Listening while the microphone is dead after a pause. We want pause to stop the recognizer. We want resume to start a new recognizer. We want the words on screen to match the microphone.

BF-2640-072 Search. We want BOS to search the whole database for the word test. We want a list of hits. We do not want a delete until Andrew says so.

BF-2640-075 Files. We want the Files page to list every file Andrew is allowed to see, ten or twenty per page. We want the search box to shorten that list as Andrew types. We want each row to show a description and the records the file is linked to.

BF-2640-080 Foreman times. We want Foreman to read Andrew existing BOS appointments before Foreman offers a time.

BF-2640-082 Training. Andrew turned Training on. Make Training in the Menu a real link to the existing training screens. Do not invent new lesson names. Lessons stay L1 L2 L3 L4 until Andrew pastes L5 through L8. Do not add web search or Places.

Finished in BOS 1.8.2

These tickets are in BOS 1.8.2 on main at commit 9823b57. Live BOS gets them after Andrew runs Manual Deploy of main on Render.

BF-2640-079 Cancelled appointments. Now cancelled visits still appear under Upcoming. We do not want cancelled visits in Upcoming.

BF-2640-077 Job to customer. We want a click on a job record to open that customer main record.

BF-2640-071 Phone photos named image.jpg, image.jpeg, or image.JPG. We want those files renamed i001.jpg, i002.jpg, and so on. We want one company counter. We do not want to rename a file that already has a real name.

BF-2640-076 Foreman notes. We want Foreman to save Andrew raw bug and feature notes. We want Andrew to download that list from Desk. BF-2640-076 is a to-do. BF-2640-076 is not a folder.

BF-2640-078 Email compose. Now Foreman can send email body text and cannot attach a PDF. We want Email on a customer to open a compose window. We want Andrew to tick files already on that customer. We want canned notes including warranty and referral. We want Foreman to fill the window. We want Andrew to confirm before send. We want a floating preview like Foreman with Close, Previous, Next, PDF zoom, and Add this file to Email. Add this file to Email attaches the file and closes the preview. The typed draft stays. No PDF thumbnails.

BF-2640-081 Phone Back. Now the phone bottom bar has Overview, Appts, Pipeline, and Menu. We want Back on the far left of that same bar. We want Back to open the last BOS dashboard page Andrew was on. We do not want Back to open login or the public booking page. If Andrew is on the first page of that visit, Back does nothing. This replaces the four-destination phone rule from BOS 1.8.0 on the phone only.

Finished in BOS 1.8.1

BF-2639-049, BF-2639-050, BF-2639-051, BF-2639-053, BF-2639-054, BF-2639-055, BF-2639-056, BF-2639-058, BF-2639-060, BF-2639-064, BF-2639-065, BF-2639-066, BF-2639-067, BF-2639-068, BF-2639-069. History names also shipped: FF-3926-003, FF-3926-004, FF-3926-012, FF-3926-013, FF-3926-014.

BF-2639-051 was the old placement of the five-question form, on Callback by Owner and More Info by Email. FF-2640-025 is the placement Andrew locked on October 3, 2026: Short Design Consultation and Long Design Consultation show the five questions on the booking page, before the visit is booked, and no other visit type shows the form.

Finished in BOS 1.8.0

See CHANGELOG.md including 001, 022, 023, 025, 028, 033, 034, 046, 047, 048.

Lessons

L1 door. L2 mirroring. L3 labeling. L4 implication.

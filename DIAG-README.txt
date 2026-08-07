====================================================================
  SARD - DIAGNOSTIC BUILD
  Records exactly where opening or displaying a book stops
====================================================================

Thank you for helping. This is NOT the normal Sard. It is a special
build whose only job is to record what happens when a problem occurs,
so we can see the cause instead of guessing.

It behaves exactly like normal Sard. Nothing is changed, nothing is
sent anywhere automatically, and no book content is collected.


--------------------------------------------------------------------
  WHAT TO DO  (three steps)
--------------------------------------------------------------------

  STEP 1.  Install
           Run  Sard-Setup.exe  and follow the installer.

           Windows may show a blue "Windows protected your PC" box,
           because this build is not signed. Click "More info", then
           "Run anyway". This is expected.

  STEP 2.  Try to open the PDF that will not open

           IMPORTANT: after clicking the PDF, WAIT AT LEAST 30
           SECONDS before doing anything else, even if it fails
           immediately or shows an error. The build runs extra
           checks in the background during that time, and those
           checks are the whole point of this version.

           PLEASE TRY THE PDF TWICE, waiting 30 seconds each time,
           EVEN IF THE FIRST ATTEMPT WORKS. One tester found the
           first attempt failed and the second one succeeded with
           nothing changed, and this build compares the two
           attempts against each other - so two attempts are worth
           far more to us than one.

           If read-aloud highlighting also fails for you, start it
           on one of those books afterwards and let it run for
           about 30 seconds too.

           If a book's chapter list is missing or its chapters do
           not work, open the Contents panel and try clicking a
           few chapters. (A fix for unclickable generated chapters
           is included in this build - please tell us if any book
           still misbehaves.)

           IF A BOOK OPENS AND THE PAGE IS BLACK OR BLANK:
           leave it on the screen. Do NOT close the book, do not
           go back to the library, and do not restart Sard. Try
           changing the theme once if you like, then go straight
           to STEP 3 while the black page is still in front of
           you. The report measures the page as it is at the very
           moment you press the keys, so a black page that is
           still on screen is exactly what we need.

  STEP 3.  Click the red button at the bottom-left of the window

                🛟  حفظ تقرير التشخيص  ·  Save diagnostic report

           It is always on screen, on every page, including while
           a book is open. Clicking it saves the report.

           (Ctrl + Shift + D still works as well, and now works
           while a book is open — in the previous build it did
           not, which is why it appeared to do nothing. If the
           keys ever fail, USE THE BUTTON: it needs no keyboard.)

           A message will appear confirming the report was saved,
           and the folder will open by itself:

                Documents \ Sard Diagnostics

           Send us BOTH files whose names begin with  sard-diag-
           (one ends in .txt, the other in .json).

           That is everything. You do not need to do anything else.


--------------------------------------------------------------------
  IMPORTANT
--------------------------------------------------------------------

  * Save the report **right after** the problem happens, using the
    red button. The report describes the most recent session, so
    saving it later (or after restarting Sard) may miss the failure.

  * You can save as many times as you like. Each save writes a new
    pair of files. If you are unsure which to send, send the two
    newest.

  * If you reproduce more than one problem, please save after EACH
    one, and tell us which report is which.

  * The files can be large. Please zip them before sending.


--------------------------------------------------------------------
  WHAT IS IN THE REPORT
--------------------------------------------------------------------

  The .txt file is plain text - you are welcome to open and read it.
  It contains:

    - which version of Sard and Windows you are running
    - the technical steps Sard took while the problem happened
    - which step failed, and the exact reason

  It does NOT contain the text of your books, your notes, your
  highlights, or any personal information. File names and folder
  paths do appear, because they are often part of the problem.


--------------------------------------------------------------------
  IF SOMETHING GOES WRONG
--------------------------------------------------------------------

  * Nothing happens when you press Ctrl + Shift + D
      Use the red button at the bottom-left instead. It does exactly
      the same thing and does not depend on the keyboard at all.

  * You cannot see the red button
      It sits at the bottom-left corner, above everything else. If a
      window or dialog is covering it, move that window. If it is
      genuinely not there, tell us - that itself is a useful fact.

  * You see a warning that the report could not be saved
      Please send us that message - it tells us something too.

  * You cannot find the folder
      Open File Explorer, go to Documents, and look for the folder
      named "Sard Diagnostics".


--------------------------------------------------------------------
  WHEN YOU ARE FINISHED
--------------------------------------------------------------------

  This build is only for finding these problems. Once we have the
  reports, you can uninstall it normally (Settings > Apps > Sard) and
  go back to the regular version. Your library, reading positions,
  notes and highlights are NOT affected either way.

  Thank you - a single one of these reports saves us days of guessing.

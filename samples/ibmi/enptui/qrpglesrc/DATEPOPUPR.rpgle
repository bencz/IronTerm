      //***************************************************************
      //   ___             _    _     __ __             _    _        *
      //  | . > ___  ___ _| |_ | |_  |  \  \ ___  _ _ _| |_ <_>._ _   *
      //  | . \/ . \/ . \ | |  | . | |     |<_> || '_> | |  | || ' |  *
      //  |___/\___/\___/ |_|  |_|_| |_|_|_|<___||_|   |_|  |_||_|_|  *
      //                                                              *
      //                                         booth@martinvt.com   *
      //***************************************************************
      // A program to show a pop-up calendar                          *
      //    7/02  Booth M.  Rewritten 2/12 & 5/2014 & 2/2018          *
      //                                                              *
      // Notes on use:                                                *
      //   1 - This calendar also works if no parm is used.           *
      //   2 - The parm is defined as a date field:                   *
      //         (not numeric, not alpha, but as a date field)        *
      //   3 - If *loval is passed in then the calendar is set        *
      //       at today's date.                                       *
      //   4 - When F3 or F12 is pressed the job ends with the        *
      //       parm unchanged.                                        *
      //   5 - A mouse button click selects a date.                   *
      //                                                              *
      //  Original source came from:                                  *
      //  http://www.400times.com/FrameData/Pop-up_Calendar.htm       *
      //    Modifications:                                            *
      //    05/02/11 C.Wilt - Replaced a couple of bunches of IF      *
      //                       statements with loops.  Modified  to   *
      //                       exit only on valid select or F3/F12    *
      //                       Protect all day fields                 *
      //   06/13/11 C.Wilt - Modified to work with both DS3 and DS4   *
      //                      screen sizes.                           *
      //***************************************************************
     h COPYRIGHT('(C) Copyright Booth Martin, 2018 All rights reserved.')
     h option(*nodebugio) dftactgrp(*no) actgrp(*caller)
     fDATEPOPUPDcf   e             workstn

     d SelectedDate    s               d
     d wDate           s               d
      // Use firstdate to figure 1st day-of-month (1900-01-07 is a Sunday).
     d firstdate       s               d   inz(d'1900-01-07')
     d day#            s              2s 0
     d wNdx            s             10i 0
     d wString         s             10
     d wMONTHYEAR      s                   like(MONTHYEAR)
     d CurYear         s              4s 0
     d CurMonth        s              2s 0
     d CurDay          s              2
      // Array of slots on calendar (6 rows of 7 days)
     d                 ds
     d wCalendar                     84
      * Fill the screen's 42 slots from the wCalendar array.
     d   day01                             overlay(wCalendar)
     d   day02                             overlay(wCalendar: *next)
     d   day03                             overlay(wCalendar: *next)
     d   day04                             overlay(wCalendar: *next)
     d   day05                             overlay(wCalendar: *next)
     d   day06                             overlay(wCalendar: *next)
     d   day07                             overlay(wCalendar: *next)
     d   day08                             overlay(wCalendar: *next)
     d   day09                             overlay(wCalendar: *next)
     d   day10                             overlay(wCalendar: *next)
     d   day11                             overlay(wCalendar: *next)
     d   day12                             overlay(wCalendar: *next)
     d   day13                             overlay(wCalendar: *next)
     d   day14                             overlay(wCalendar: *next)
     d   day15                             overlay(wCalendar: *next)
     d   day16                             overlay(wCalendar: *next)
     d   day17                             overlay(wCalendar: *next)
     d   day18                             overlay(wCalendar: *next)
     d   day19                             overlay(wCalendar: *next)
     d   day20                             overlay(wCalendar: *next)
     d   day21                             overlay(wCalendar: *next)
     d   day22                             overlay(wCalendar: *next)
     d   day23                             overlay(wCalendar: *next)
     d   day24                             overlay(wCalendar: *next)
     d   day25                             overlay(wCalendar: *next)
     d   day26                             overlay(wCalendar: *next)
     d   day27                             overlay(wCalendar: *next)
     d   day28                             overlay(wCalendar: *next)
     d   day29                             overlay(wCalendar: *next)
     d   day30                             overlay(wCalendar: *next)
     d   day31                             overlay(wCalendar: *next)
     d   day32                             overlay(wCalendar: *next)
     d   day33                             overlay(wCalendar: *next)
     d   day34                             overlay(wCalendar: *next)
     d   day35                             overlay(wCalendar: *next)
     d   day36                             overlay(wCalendar: *next)
     d   day37                             overlay(wCalendar: *next)
     d   day38                             overlay(wCalendar: *next)
     d Arr                            2    dim(38) overlay(wCalendar)
      //  Number of days in the month:
     d pdmds           ds
     d                                2  0 inz(31)
     d                                2  0 inz(28)
     d                                2  0 inz(31)
     d                                2  0 inz(30)
     d                                2  0 inz(31)
     d                                2  0 inz(30)
     d                                2  0 inz(31)
     d                                2  0 inz(31)
     d                                2  0 inz(30)
     d                                2  0 inz(31)
     d                                2  0 inz(30)
     d                                2  0 inz(31)
     d                                2  0 inz(01)
     d pdm                            2  0 dim(13) overlay(pdmds)
     d MonthNames      ds
     d                                9    inz('January  ')
     d                                9    inz('February ')
     d                                9    inz('March    ')
     d                                9    inz('April    ')
     d                                9    inz('May      ')
     d                                9    inz('June     ')
     d                                9    inz('July     ')
     d                                9    inz('August   ')
     d                                9    inz('September')
     d                                9    inz('October  ')
     d                                9    inz('November ')
     d                                9    inz('December ')
     d  MthNam                        9    dim(12) overlay(MonthNames)

     d SetScreenSize   pr            10i 0 extproc('QsnRtvScrDim')
     d   NbrRows                     10i 0 options(*omit)
     d   NbrCols                     10i 0 options(*omit)
     d   Handle                      10i 0 options(*omit)
     d   ErrorCode                32767    options(*varsize: *omit)
     d   NbrColumns    s             10i 0

     d DATEPOPUP       pr
     d  pDate                          d   options(*omit)
     d  pRow                          2  0 options(*omit)
     d  pPos                          3  0 options(*omit)
     d DATEPOPUPR      pi
     d  pDate                          d   options(*omit)
     d  pRow                          2  0 options(*omit)
     d  pPos                          3  0 options(*omit)
      // ===============================================================
      // ==         Mainline                                          ==
      // ===============================================================
      /free
       //check current screen size, configure to match
       SetScreenSize(*omit:NbrColumns:*omit:*omit);
       if nbrColumns = 132;
         *in90 = *on;
       else;
         *in90 = *off;
       endif;
       if (%parms >= 1) and (pdate <> *loval);       // Starting date?
         SelectedDate = pDate;
       else;
         SelectedDate = %date();
       endif;
       if (%parms = 3);      // location of window
         WROW = pRow;
         WPOS = pPos;
       else;
         if *in90;            // 132-column screen
           WROW = 12;
           WPOS = 50;
         else;                //  80-column screen
           WROW = 8;
           WPOS = 35;
         endif;
       endif;
       exsr FillCalendar;
       dow not *inlr;
         exfmt fmt001;
         select;
         when *inkl or *inkc or CSRFLD = 'REDX';              // exit/return
           *inlr = *on;
         when CSRFLD = 'PREVYEAR';                            // Go back one year.
           SelectedDate = SelectedDate - %years(1);
           exsr FillCalendar;
         when CSRFLD = 'PREVMONTH';  // Pagedown              // Go back one month
           SelectedDate = SelectedDate - %months(1);
           exsr FillCalendar;
         when CSRFLD = 'NEXTMONTH';  // Pageup                // Go forward one month
           SelectedDate = SelectedDate + %months(1);
           exsr FillCalendar;
         when CSRFLD = 'NEXTYEAR';                            // Go forward one year.
           SelectedDate = SelectedDate + %years(1);
           exsr FillCalendar;
         when CSRFLD = ' ' or CSRFLD = 'MONTHYEAR';           // no date selected
         other;
           exsr FillSelectedDate;
           if %parms >= 1 and %subst(CSRFLD: 1: 3) = 'DAY';   // end of job.
             pDate = SelectedDate;
             *inlr = *on;
           else;
             exsr FillCalendar;     // (No parm, loop around
           endif;
         endsl;
       enddo;
       *inlr = *on;
       // ===============================================================
       // ==         Sub Routines                                      ==
       // ===============================================================
       //-------------------------------------------------------------------
       //--  Fill the calendar fields.                                    --
       //-------------------------------------------------------------------
       begsr FillCalendar;
         // Get fields to fill calendar
         CurYear  = %subdt(SelectedDate: *y);
         CurMonth = %subdt(SelectedDate: *m);
         CurDay   = %char(%subdt(SelectedDate: *d));
         clear MONTHYEAR;
         wMONTHYEAR = %trim(mthnam(CurMonth)) + ', ' + %char(CurYear);
         wNdx = (%size(MONTHYEAR) - %len(%trim(wMONTHYEAR))) / 2;
         %subst(MONTHYEAR: wNdx) = %trim(wMONTHYEAR);
         // is this a leap year?
         if %rem(CurYear: 4) = 0
               and CurYear <> 2000;
           pdm(2) = 29;
         else;
           pdm(2) = 28;
         endif;
         // Fill array with date numbers
         clear arr;
         // Find day of the week for first day on the calendar
         wDate = SelectedDate - %days(%int(CurDay) - 1);
         day# = %rem((%diff(wDate: firstdate: *days)): 7) + 1;
         // Fill the calendar slots with days of the month, beginning @ day#
         for wNdx = 1 to pdm(CurMonth);
           evalr Arr(day#) = %char(wNdx);
           if %char(wNdx) = CurDay;
             exsr SetCursor;
           endif;
           day# += 1;
         endfor;
       endsr;
       //-------------------------------------------------------------------
       //--  Set the cursor location on the calendar                      --
       //-------------------------------------------------------------------
       begsr SetCursor;
         select;
           when day# >= 36;
             CSRROW = 9;
           when day# >= 29;
             CSRROW = 8;
           when day# >= 22;
             CSRROW = 7;
           when day# >= 15;
             CSRROW = 6;
           when day# >= 8;
             CSRROW = 5;
           when day# >= 1;
             CSRROW = 4;
         endsl;
         select;
           when %rem(day#: 7) = 0;
             CSRPOS = 19;
           when %rem(day#: 7) = 6;
             CSRPOS = 16;
           when %rem(day#: 7) = 5;
             CSRPOS = 13;
           when %rem(day#: 7) = 4;
             CSRPOS = 10;
           when %rem(day#: 7) = 3;
             CSRPOS = 7;
           when %rem(day#: 7) = 2;
             CSRPOS = 4;
           when %rem(day#: 7) = 1;
             CSRPOS = 1;
         endsl;
       endsr;
       //-------------------------------------------------------------------
       //--  Fill SelectedDate field from Pop-up calendar                 --
       //-------------------------------------------------------------------
       begsr FillSelectedDate;
         wNdx = %int(%subst(%trim(csrfld): 4: 2));
         if Arr(wNdx) > ' ';
           wNdx = %int(Arr(wNdx));
           if wNdx < 10;  // Re-insert leading zero if day is 1st - 9th.
             CurDay = '0' + %trim(%char(wNdx));
           else;
             CurDay = %char(wNdx);
           endif;
         endif;
         wString = %editc(CurYear: 'X') + '-'
                 + %editc(CurMonth: 'X') + '-'
                 + CurDay;
         SelectedDate = %date(wString: *iso);
       endsr;

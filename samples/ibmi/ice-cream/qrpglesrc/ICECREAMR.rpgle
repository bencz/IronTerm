      //***************************************************************
      //   ___             _    _     __ __             _    _        *
      //  | . > ___  ___ _| |_ | |_  |  \  \ ___  _ _ _| |_ <_>._ _   *
      //  | . \/ . \/ . \ | |  | . | |     |<_> || '_> | |  | || ' |  *
      //  |___/\___/\___/ |_|  |_|_| |_|_|_|<___||_|   |_|  |_||_|_|  *
      //                                                              *
      //  A program to demo scroll bar & check box.                   *
      //                                                              *
      //   3/2013                                 booth@martinvt.com  *
      //***************************************************************
     h COPYRIGHT('Booth Martin, 2013,  All rights reserved.')
     h option(*nodebugio) dftactgrp(*no) actgrp(*new)

     fICECREAMD cf   e             workstn SFILE(SFL1:SF1RRN)
     fICECREAMP uf a e           k disk

      *--------------------------------------------------------------------*
      * DEFINITIONS                                                        *
      *--------------------------------------------------------------------*
      * Working fields.
     d wNdx            s                   like(SF1RRN)
     d wSvCB01CHC      s                   like(CB01CHC)
     d wSvCB02CHC      s                   like(CB02CHC)
     d wRefill         s               n

      * Prototypes.
     d PublishWebPage  pr                  extpgm('ICIFSHTMLR')
     d GetFigletArt    pr                  extpgm('FIGLET05R')
     d                               15
     d                                2  0
     d                                3  0
     d                             1440
     d pKey            s             15
     d pRows           s              2  0
     d pCols           s              3  0
     d pArt            s           1440

       //====================================================================*
       // MAINLINE                                                           *
       //====================================================================*
      /free
         exsr FillSFL1;
         // Edit the ICECREAMP file.
         dou *inkc;
           write S1CMD;
           exfmt S1FMT;
           select;
           when *inkc;
             exsr ExitPgm;
           when *inke;
             exsr RefreshSFL1;
           when *inkj;
             PublishWebPage();
           other;
             exsr UpdateICECREAMP;
           endsl;
         enddo;
       //====================================================================*
       // MAINLINE-END                                                       *
       //====================================================================*
       //-------------------------------*  Sub-Routine  *
       // *inzsr()                      *---------------*
       // Initializing sub routine                      *
       //-----------------------------------------------*
       begsr *inzsr;
         pKey = 'Ice Cream';       // Get Heading for screen
         pRows = 5;
         pCols = 65;
         clear pArt;
         GetFigletArt(pKey: pRows: pCols: pArt);
         HDG5X65 = %subst(pArt: 1: (pCols * pRows));
         CB01CHC = 0;
         CB02CHC = 0;
         CB01 = 'Show only available flavors.';
         CB02 = 'Allow editing of flavors.';
       endsr;
       //-------------------------------*  Sub-Routine  *
       // ExitPgm()                     *---------------*
       // end of processing                             *
       //-----------------------------------------------*
       begsr ExitPgm;
         *inlr = *on;
         return;
       endsr;
       //-------------------------------*  Sub-Routine  *
       // FillSFL1()                    *---------------*
       // Fill the subfile.                             *
       //-----------------------------------------------*
       begsr FillSFL1;
         *in50 = *on;
         clear SFL1;
         write S1FMT;
         *in50 = *off;
           SF1RRN = 0;
         if CB02CHC = 1;   // protect mode.
           *in31 = *on;
         else;
           *in31 = *off;
         endif;
         // Fill the subfile:
         setll *start ICECREAMP;
         read(n) ICECREAMP;
         dow not %eof;
           if CB01CHC = 0
              or (CB01CHC = 1 and ICAVAIL <> ' '); // Show only available items.
             if ICAVAIL <> ' ';
               S1ICAVAIL = 'Y';
             else;
               S1ICAVAIL = ' ';
             endif;
             S1ICIMAGE = ICIMAGE;
             S1ICFLAVOR = ICFLAVOR;
             S1SVFLAVOR = S1ICFLAVOR;  // Save original data.
             S1SVAVAIL = S1ICAVAIL;
             S1SVIMAGE = S1ICIMAGE;
             SF1RRN = SF1RRN + 1;
             write SFL1;
           endif;
           read(n) ICECREAMP;
         enddo;
         S1ICFLAVOR = *blanks;  // Add some blank rows for new records
         S1ICAVAIL = *blanks;
         S1ICIMAGE = *blanks;
         S1SVFLAVOR = S1ICFLAVOR;  // Save original data.
         S1SVAVAIL = S1ICAVAIL;
         S1SVIMAGE = S1ICIMAGE;
         for wNdx = 1 to 5;
           SF1RRN = SF1RRN + 1;
           write SFL1;
         endfor;
         SF1RECS = SF1RRN;
       endsr;
       //-------------------------------*  Sub-Routine  *
       // RefreshSFL1()                 *---------------*
       //                                               *
       //-----------------------------------------------*
       begsr RefreshSFL1;
         // ReFill the subfile:
        for wNdx = 1 to SF1RECS;
          chain wNdx SFL1;
          S1ICIMAGE = S1SVIMAGE;
          S1ICFLAVOR = S1SVFLAVOR;
          if S1SVAVAIL <> ' ';
            S1ICAVAIL = 'Y';
          else;
            S1ICAVAIL = ' ';
          endif;
        endfor;
       endsr;
       //-------------------------------*  Sub-Routine  *
       // UpdateICECREAMP()             *---------------*
       // Update the data file                          *
       //-----------------------------------------------*
       begsr UpdateICECREAMP;
         wRefill = *off;
         for wNdx = 1 to SF1RECS;
           chain wNdx SFL1;
           select;
             when S1ICFLAVOR = ' ' and S1SVFLAVOR <> ' '; // delete a flavor
               delete (S1SVFLAVOR) ICECREAMP;
               wRefill = *on;
             when S1ICFLAVOR <> ' ' and S1SVFLAVOR = ' '; // add a flavor
               ICFLAVOR = S1ICFLAVOR;
               ICIMAGE = S1ICIMAGE;
               if S1ICAVAIL <> ' ';
                 ICAVAIL = 'Y';
               else;
                 ICAVAIL = ' ';
               endif;
               write(e) RICECREAMP;  // It is possible to try to write a duplicate
                                     // record.  Code to deal with that issue is
                                     // beyond the scope of this demo.  BE WARNED!!
               wRefill = *on;
             when (S1SVFLAVOR <> ' ') and
                  ((S1ICFLAVOR <> S1SVFLAVOR)
                  or (S1ICAVAIL <> S1SVAVAIL)
                  or (S1ICIMAGE <> S1SVIMAGE));   // update a flavor
               chain S1SVFLAVOR ICECREAMP;
               ICFLAVOR = S1ICFLAVOR;
               ICIMAGE = S1ICIMAGE;
               if S1ICAVAIL <> ' ';
                 ICAVAIL = 'Y';
               else;
                 ICAVAIL = ' ';
               endif;
               update RICECREAMP %fields(ICFLAVOR: ICAVAIL: ICIMAGE);
               wRefill = *on;
             other;
           endsl;
           if S1ICAVAIL <> S1SVAVAIL;
             wRefill = *on;
           endif;
         endfor;
         if wSvCB01CHC <> CB01CHC
            or wSvCB02CHC <> CB02CHC;
           wRefill = *on;
           wSvCB01CHC = CB01CHC;
           wSvCB02CHC = CB02CHC;
         endif;
         if wRefill = *on;
           exsr FillSFL1;
         endif;
       endsr;

      //  ______________________________________________________________________
      //  __              _    _     __ __             _
      // | . > ___  ___ _| |_ | |_  |  \  \ ___  _ _ _| |_ <_>._ _
      // | . \/ . \/ . \ | |  | . | |     |<_> || '_> | |  | || ' |
      // |___/\___/\___/ |_|  |_|_| |_|_|_|<___||_|   |_|  |_||_|_|
      //
      //  11/2019                                booth@martinvt.com
      //  ______________________________________________________________________
      //    Web demo of get-day-of-week
      //
      //  ______________________________________________________________________
       ctl-opt
       copyright('(C) Copyright Booth Martin, 2019, All rights reserved.')
       option(*nodebugio) dftactgrp(*no) actgrp(*new);

       dcl-f WEBDOWD  workstn;

       dcl-c cTrq x'30';
       dcl-c cHTTP 'http://iseries/api/';

       dcl-s dataIn char(40);

       dcl-ds *n PSDS;
        USERID char(10) pos(358);
       end-ds;
       dcl-pr ShowPopUp extpgm('DATEPOPUPR');
        *n date;
        *n packed(2) const;
        *n packed(3) const;
       end-pr;

        //==================================================================== *
        // MAINLINE                                                            *
        //==================================================================== *
        // The immediately following /EXEC SQL set options is SQL's version of
        // RPG's H Spec. It is never executed; just used at compile time.
        // MUST be in source code above any other exec SQL statements.
          exec sql set option
           Commit = *None,
           SrtSeq = *LangIDShr;   // allows sort & search with upper/lower
        //  ____________________________________________________________________
       /free
         exsr GetHeading;
         S1DATE = %date();       // Get today's date for initial date displayed.
         dow *inkc = *off;
           exsr ChangeColors;
           exsr GetDayName;
           exfmt FMT01;
           select;
             when *inkc;        // exit
             when *inkd or CSRFLD = 'POPUP';
               ShowPopUp(S1DATE: 13: 5);   // Pop-up calendar (row, column)
             other;
           endsl;
         enddo;
         *inlr = *on;
        //====================================================================*
        // MAINLINE-END                                                       *
        //====================================================================*
        //-------------------------------*  Sub-Routine  *
        // Get name of any day           *---------------*
        //-----------------------------------------------*
        begsr GetDayName;
          clear S1DAYNAME;

          // The demo's original HTTP endpoint is not available on PUB400.
          // Produce the same text locally without changing the screen flow.
          exec sql values varchar_format(:S1DATE, 'YYYY-MM-DD') concat
                   ' is a ' concat dayname(:S1DATE)
            into :S1DAYNAME;
        endsr;
        //-------------------------------*  Sub-Routine  *
        // GetHeading()                  *---------------*
        //-----------------------------------------------*
        begsr GetHeading;
          HDG5X40 =
                    '   _      __    __                      '
                  + '  | | /| / /__ / /   -= Get the name =- '
                  + '  | |/ |/ / -_) _ \  -=  of the day  =- '
                  + '  |__/|__/\__/_.__/  -= for any date =- ';
          HDG7X23 =
                    '.......................'
                  + '.                     .'
                  + '.         ,,,         .'
                  + '.        (O-O)        .'
                  + '. ----oo0-(_)-0oo---- .'
                  + '.                     .'
                  + '.......................';
         exec SQL                            // Get user's name to display.
           select CID.ODOBTX
             into :S1USERNAME
             from Table( QSYS2/USERS() ) AS CID
             where CID.ODOBNM = :USERID;
         if sqlcod <> 0 or %trim(S1USERNAME) = '';
           S1USERNAME = %trim(USERID);
         endif;
         evalr S1USERNAME = 'with' + cTrq + %trim(S1USERNAME);
        endsr;
        //-------------------------------*  Sub-Routine  *
        // Change Heading Colors         *---------------*
        //-----------------------------------------------*
        begsr ChangeColors;
          select;
            when *in61;
              *in61 = *off;
              *in62 = *on;
            when *in62;
              *in62 = *off;
              *in63 = *on;
            when *in63;
              *in63 = *off;
              *in64 = *on;
            when *in64;
              *in64 = *off;
              *in65 = *on;
            when *in65;
              *in65 = *off;
              *in66 = *on;
            when *in66;
              *in66 = *off;
              *in67 = *on;
            other;
              *in67 = *off;
              *in61 = *on;
          endsl;
        endsr;

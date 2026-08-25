      //***************************************************************
      //   ___             _    _     __ __             _    _        *
      //  | . > ___  ___ _| |_ | |_  |  \  \ ___  _ _ _| |_ <_>._ _   *
      //  | . \/ . \/ . \ | |  | . | |     |<_> || '_> | |  | || ' |  *
      //  |___/\___/\___/ |_|  |_|_| |_|_|_|<___||_|   |_|  |_||_|_|  *
      //                                                              *
      //  A program to demo a Moveable window   MOVEWDWR              *
      //                                                              *
      //  11/2012                                 booth@martinvt.com  *
      //***************************************************************
      // COMMENTS                                                     *
      //  Code originally written by:                                 *
      //                                                              *
      //        mit besten Grüssen/kind regards                       *
      //                                                              *
      //                 Hans Bertol                                  *
      //           ÖAF Gräf & Stift AG Wien                           *
      //           Tel +43-1-86631-129                                *
      //           Fax +43-1-86631-109                                *
      //                               mailto:Hans_Bertol@mn.man.de   *
      //***************************************************************

     H COPYRIGHT('(C) ÖAF Gräf & Stift AG Wien 1992, 2001.')
     H OPTION(*SRCSTMT : *NODEBUGIO)   AUT(*CHANGE)

     FMOVEWDWD  cf   e             workstn

      //  Maximal = screensize  -  windowsize
     d MaxCol          s              3  0 Inz(45)
     d MaxRow          s              3  0 Inz(16)

      /FREE

       R1 = 13;
       C1 = 31;
       write FMT01;

       dow not *inkc;
         ROW1 = '  To row   ' + %trim(%editc(R1: 'J'))
             + ' & col.' + %trim(%editc(C1: 'J'));
         ROW2 = '  From row ' + %trim(%editc((R0 + 1): 'J'))
             + ' & col.' + %trim(%editc((C0 + 2): 'J'));
         ROW4 = ' Just click with the mouse   ';
         ROW5 = ' somewhere on the screen and ';
         ROW6 = ' this window will move there.';
         //    Calculate the new window position
         R0 = R1 - 1;
         C0 = C1 - 2;
         //    Check if the window  position fits into the screen
         if R0 > MaxRow; //  Row Position
           R0 = MaxRow;
         ROW4 = ' The window is prevented     ';
         ROW5 = ' moving off the screen when  ';
         ROW6 = ' clicked near the bottom.    ';
         endif;
         if R0 < 1;
           R0 = 1;
         endif;
         if C0 > MaxCol;   // column position
           C0 = MaxCol;
         ROW4 = ' The window is prevented     ';
         ROW5 = ' moving off the screen when  ';
         ROW6 = ' clicked near the edge.      ';
         endif;
         if C0 < 2;
           C0 = 2;
         endif;
         exfmt WIN1;
       enddo;
       *inlr = *on;
